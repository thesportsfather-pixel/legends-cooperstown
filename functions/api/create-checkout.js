function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function supabaseGet(env, path) {
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      accept: "application/json",
    },
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Supabase ${response.status}: ${text}`);
  }

  return text ? JSON.parse(text) : [];
}

export async function onRequestPost({ request, env }) {
  try {
    if (
      !env.SUPABASE_URL ||
      !env.SUPABASE_SERVICE_ROLE_KEY ||
      !env.STRIPE_SECRET_KEY
    ) {
      return json({ error: "Missing server configuration." }, 500);
    }

    const body = await request.json();

    const {
      playerKey,
      baseballs,
      donorName,
      anonymous,
    } = body || {};

    if (
      typeof playerKey !== "string" ||
      !Array.isArray(baseballs) ||
      baseballs.length === 0
    ) {
      return json(
        { error: "A player and at least one baseball are required." },
        400
      );
    }

    const isAnonymous = anonymous === true;

    let cleanedDonorName = "";

    if (!isAnonymous) {
      cleanedDonorName =
        typeof donorName === "string"
          ? donorName.trim().replace(/\s+/g, " ")
          : "";

      if (cleanedDonorName.length < 2) {
        return json(
          {
            error:
              "Please enter the name you want displayed or choose Anonymous.",
          },
          400
        );
      }

      if (cleanedDonorName.length > 80) {
        return json(
          { error: "Display name must be 80 characters or fewer." },
          400
        );
      }
    }

    const displayDonorName = isAnonymous
      ? "Anonymous"
      : cleanedDonorName;

    const selectedNumbers = [
      ...new Set(
        baseballs
          .map((n) => Number(n))
          .filter(
            (n) =>
              Number.isInteger(n) &&
              n >= 1 &&
              n <= 100
          )
      ),
    ].sort((a, b) => a - b);

    if (
      selectedNumbers.length === 0 ||
      selectedNumbers.length !== baseballs.length
    ) {
      return json({ error: "Invalid baseball selection." }, 400);
    }

    const players = await supabaseGet(
      env,
      `players?player_key=eq.${encodeURIComponent(
        playerKey
      )}&select=id,player_key,player_name&limit=1`
    );

    const player = players[0];

    if (!player) {
      return json({ error: "Player not found." }, 404);
    }

    const inList = selectedNumbers.join(",");

    const rows = await supabaseGet(
      env,
      `baseballs?player_id=eq.${encodeURIComponent(
        player.id
      )}&ball_number=in.(${inList})&select=id,ball_number,amount_cents,status,reserved_until&order=ball_number.asc`
    );

    if (!rows || rows.length !== selectedNumbers.length) {
      return json(
        {
          error:
            "One or more baseballs could not be found. Please refresh and try again.",
        },
        409
      );
    }

    const unavailable = rows.filter(
      (ball) => ball.status === "sold"
    );

    if (unavailable.length) {
      return json(
        {
          error:
            "Baseball(s) #" +
            unavailable.map((b) => b.ball_number).join(", #") +
            " are already sold. Please refresh your board.",
        },
        409
      );
    }

    const totalCents = rows.reduce(
      (sum, ball) => sum + Number(ball.amount_cents || 0),
      0
    );

    if (totalCents <= 0) {
      return json({ error: "Invalid donation total." }, 400);
    }

    const origin = new URL(request.url).origin;

    const form = new URLSearchParams();

    form.set("mode", "payment");
    form.set("line_items[0][price_data][currency]", "usd");
    form.set(
      "line_items[0][price_data][unit_amount]",
      String(totalCents)
    );
    form.set(
      "line_items[0][price_data][product_data][name]",
      "Legends Road to Cooperstown Fundraiser"
    );
    form.set(
      "line_items[0][price_data][product_data][description]",
      `${player.player_name} — Baseballs #${selectedNumbers.join(", #")}`
    );
    form.set("line_items[0][quantity]", "1");

    form.set(
      "success_url",
      `${origin}/?player=${encodeURIComponent(
        player.player_key
      )}&payment=success&session_id={CHECKOUT_SESSION_ID}`
    );

    form.set(
      "cancel_url",
      `${origin}/?player=${encodeURIComponent(
        player.player_key
      )}&payment=cancelled`
    );

    form.set("customer_creation", "always");

    form.set("metadata[team_key]", "legends-cooperstown");
    form.set("metadata[player_key]", player.player_key);
    form.set("metadata[player_id]", String(player.id));
    form.set("metadata[player_name]", player.player_name);
    form.set(
      "metadata[baseball_numbers]",
      selectedNumbers.join(",")
    );
    form.set(
      "metadata[donation_total_cents]",
      String(totalCents)
    );
    form.set(
      "metadata[donor_name]",
      displayDonorName
    );
    form.set(
      "metadata[anonymous]",
      isAnonymous ? "true" : "false"
    );

    form.set(
      "payment_intent_data[metadata][team_key]",
      "legends-cooperstown"
    );
    form.set(
      "payment_intent_data[metadata][player_key]",
      player.player_key
    );
    form.set(
      "payment_intent_data[metadata][player_id]",
      String(player.id)
    );
    form.set(
      "payment_intent_data[metadata][player_name]",
      player.player_name
    );
    form.set(
      "payment_intent_data[metadata][baseball_numbers]",
      selectedNumbers.join(",")
    );
    form.set(
      "payment_intent_data[metadata][donor_name]",
      displayDonorName
    );
    form.set(
      "payment_intent_data[metadata][anonymous]",
      isAnonymous ? "true" : "false"
    );

    const stripeResponse = await fetch(
      "https://api.stripe.com/v1/checkout/sessions",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
      }
    );

    const stripeText = await stripeResponse.text();

    let session;

    try {
      session = JSON.parse(stripeText);
    } catch {
      return json(
        {
          error:
            `Stripe returned an invalid response: ${stripeText}`,
        },
        500
      );
    }

    if (!stripeResponse.ok) {
      return json(
        {
          error:
            session?.error?.message ||
            "Unable to create Stripe checkout session.",
        },
        stripeResponse.status
      );
    }

    if (!session.url) {
      return json(
        { error: "Stripe did not return a checkout URL." },
        500
      );
    }

    return json({
      url: session.url,
      sessionId: session.id,
      totalCents,
      donorName: displayDonorName,
      anonymous: isAnonymous,
    });

  } catch (error) {
    console.error("Create checkout error:", error);

    return json(
      {
        error:
          error instanceof Error
            ? error.message
            : String(error),
      },
      500
    );
  }
}

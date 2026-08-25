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
    method: "GET",
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
      return json(
        {
          success: false,
          error: "Missing server configuration.",
        },
        500
      );
    }

    const body = await request.json();

    const playerKey =
      typeof body.playerKey === "string"
        ? body.playerKey.trim()
        : "";

    const anonymous =
      body.anonymous === true;

    let donorName =
      typeof body.donorName === "string"
        ? body.donorName.trim().replace(/\s+/g, " ")
        : "";

    if (anonymous || !donorName) {
      donorName = "Anonymous";
    }

    if (
      !anonymous &&
      donorName.length < 2
    ) {
      return json(
        {
          success: false,
          error:
            "Please enter a donor name or choose Anonymous.",
        },
        400
      );
    }

    const baseballNumbers =
      Array.from(
        new Set(
          (
            Array.isArray(body.baseballs)
              ? body.baseballs
              : []
          )
            .map(Number)
            .filter(
              (number) =>
                Number.isInteger(number) &&
                number >= 1 &&
                number <= 100
            )
        )
      ).sort((a, b) => a - b);

    if (
      !playerKey ||
      !baseballNumbers.length
    ) {
      return json(
        {
          success: false,
          error:
            "A player and at least one baseball are required.",
        },
        400
      );
    }

    const players =
      await supabaseGet(
        env,
        `players?team_key=eq.legends-cooperstown&player_key=eq.${encodeURIComponent(
          playerKey
        )}&select=id,player_key,player_name,player_number&limit=1`
      );

    if (!players.length) {
      return json(
        {
          success: false,
          error: "Player not found.",
        },
        404
      );
    }

    const player =
      players[0];

    const baseballs =
      await supabaseGet(
        env,
        `baseballs?player_id=eq.${encodeURIComponent(
          player.id
        )}&ball_number=in.(${baseballNumbers.join(
          ","
        )})&select=ball_number,amount_cents,status`
      );

    if (
      baseballs.length !==
      baseballNumbers.length
    ) {
      return json(
        {
          success: false,
          error:
            "One or more selected baseballs could not be found.",
        },
        409
      );
    }

    const unavailable =
      baseballs.filter(
        (ball) =>
          ball.status !== "available"
      );

    if (unavailable.length) {
      return json(
        {
          success: false,
          error:
            `Baseball${
              unavailable.length === 1 ? "" : "s"
            } #${unavailable
              .map(
                (ball) =>
                  ball.ball_number
              )
              .join(
                ", #"
              )} ${
              unavailable.length === 1
                ? "is"
                : "are"
            } no longer available. Please refresh and choose again.`,
        },
        409
      );
    }

    const amountCents =
      baseballs.reduce(
        (sum, ball) =>
          sum +
          (
            Number(
              ball.amount_cents
            ) ||
            Number(
              ball.ball_number
            ) * 100
          ),
        0
      );

    if (amountCents < 50) {
      return json(
        {
          success: false,
          error:
            "Invalid checkout amount.",
        },
        400
      );
    }

    const origin =
      new URL(
        request.url
      ).origin;

    const successUrl =
      `${origin}/fundraiser.html?player=${encodeURIComponent(
        playerKey
      )}&payment=success&session_id={CHECKOUT_SESSION_ID}`;

    const cancelUrl =
      `${origin}/fundraiser.html?player=${encodeURIComponent(
        playerKey
      )}&payment=cancelled`;

    const params =
      new URLSearchParams();

    params.set(
      "mode",
      "payment"
    );

    params.set(
      "success_url",
      successUrl
    );

    params.set(
      "cancel_url",
      cancelUrl
    );

    params.set(
      "line_items[0][price_data][currency]",
      "usd"
    );

    params.set(
      "line_items[0][price_data][product_data][name]",
      `Legends Baseball - ${player.player_name}`
    );

    params.set(
      "line_items[0][price_data][product_data][description]",
      `Baseballs #${baseballNumbers.join(
        ", #"
      )} • Donor: ${donorName}`
    );

    params.set(
      "line_items[0][price_data][unit_amount]",
      String(
        amountCents
      )
    );

    params.set(
      "line_items[0][quantity]",
      "1"
    );

    params.set(
      "metadata[team_key]",
      "legends-cooperstown"
    );

    params.set(
      "metadata[player_id]",
      String(
        player.id
      )
    );

    params.set(
      "metadata[player_key]",
      player.player_key
    );

    params.set(
      "metadata[player_name]",
      player.player_name
    );

    params.set(
      "metadata[player_number]",
      String(
        player.player_number ??
          ""
      )
    );

    params.set(
      "metadata[baseball_numbers]",
      baseballNumbers.join(
        ","
      )
    );

    params.set(
      "metadata[donor_name]",
      donorName
    );

    params.set(
      "metadata[anonymous]",
      String(
        anonymous
      )
    );

    const stripeResponse =
      await fetch(
        "https://api.stripe.com/v1/checkout/sessions",
        {
          method: "POST",

          headers: {
            authorization:
              `Bearer ${env.STRIPE_SECRET_KEY}`,

            "content-type":
              "application/x-www-form-urlencoded",

            accept:
              "application/json",
          },

          body:
            params.toString(),
        }
      );

    const stripeText =
      await stripeResponse.text();

    let session;

    try {
      session =
        JSON.parse(
          stripeText
        );
    } catch {
      return json(
        {
          success: false,
          error:
            `Stripe returned an invalid response: ${stripeText}`,
        },
        500
      );
    }

    if (
      !stripeResponse.ok
    ) {
      return json(
        {
          success: false,
          error:
            session?.error
              ?.message ||
            "Unable to create Stripe checkout session.",
        },
        stripeResponse.status
      );
    }

    return json({
      success: true,
      url:
        session.url,
      sessionId:
        session.id,
    });

  } catch (error) {
    console.error(
      "Create checkout error:",
      error
    );

    return json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : String(error),
      },
      500
    );
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function supabasePatch(
  env,
  path,
  data
) {
  const response =
    await fetch(
      `${env.SUPABASE_URL}/rest/v1/${path}`,
      {
        method:
          "PATCH",

        headers: {
          apikey:
            env.SUPABASE_SERVICE_ROLE_KEY,

          authorization:
            `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,

          "content-type":
            "application/json",

          prefer:
            "return=representation",

          accept:
            "application/json",
        },

        body:
          JSON.stringify(
            data
          ),
      }
    );

  const text =
    await response.text();

  if (
    !response.ok
  ) {
    throw new Error(
      `Supabase ${response.status}: ${text}`
    );
  }

  return text
    ? JSON.parse(
        text
      )
    : [];
}

export async function onRequestGet({
  request,
  env,
}) {
  try {
    if (
      !env.SUPABASE_URL ||
      !env.SUPABASE_SERVICE_ROLE_KEY ||
      !env.STRIPE_SECRET_KEY
    ) {
      return json(
        {
          success: false,
          error:
            "Missing server configuration.",
        },
        500
      );
    }

    const url =
      new URL(
        request.url
      );

    const sessionId =
      url.searchParams.get(
        "session_id"
      );

    if (
      !sessionId ||
      typeof sessionId !==
        "string" ||
      !sessionId.startsWith(
        "cs_"
      )
    ) {
      return json(
        {
          success: false,
          error:
            "A valid Stripe session_id is required.",
        },
        400
      );
    }

    const stripeResponse =
      await fetch(
        `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(
          sessionId
        )}`,
        {
          method:
            "GET",

          headers: {
            authorization:
              `Bearer ${env.STRIPE_SECRET_KEY}`,

            accept:
              "application/json",
          },
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
            session
              ?.error
              ?.message ||
            "Unable to retrieve Stripe checkout session.",
        },
        stripeResponse.status
      );
    }

    if (
      session.payment_status !==
      "paid"
    ) {
      return json(
        {
          success: false,

          paid:
            false,

          error:
            "Stripe has not marked this checkout session as paid.",
        },
        409
      );
    }

    const teamKey =
      session.metadata
        ?.team_key;

    const playerId =
      session.metadata
        ?.player_id;

    const playerKey =
      session.metadata
        ?.player_key;

    const baseballCsv =
      session.metadata
        ?.baseball_numbers;

    if (
      teamKey !==
        "legends-cooperstown" ||
      !playerId ||
      !playerKey ||
      !baseballCsv
    ) {
      return json(
        {
          success: false,

          error:
            "Missing or invalid Legends fundraiser metadata.",
        },
        400
      );
    }

    const baseballNumbers =
      baseballCsv
        .split(
          ","
        )
        .map(
          (value) =>
            Number(
              value.trim()
            )
        )
        .filter(
          (value) =>
            Number.isInteger(
              value
            ) &&
            value >=
              1 &&
            value <=
              100
        );

    if (
      !baseballNumbers.length
    ) {
      return json(
        {
          success: false,

          error:
            "No valid baseball numbers were found in Stripe metadata.",
        },
        400
      );
    }

    const isAnonymous =
      session.metadata
        ?.anonymous ===
      "true";

    let donorName =
      typeof session
        .metadata
        ?.donor_name ===
      "string"
        ? session.metadata.donor_name.trim()
        : "";

    if (
      isAnonymous ||
      !donorName
    ) {
      donorName =
        "Anonymous";
    }

    const soldRows =
      await supabasePatch(
        env,

        `baseballs?player_id=eq.${encodeURIComponent(
          playerId
        )}&ball_number=in.(${baseballNumbers.join(
          ","
        )})`,

        {
          status:
            "sold",

          sold_at:
            new Date().toISOString(),

          reserved_until:
            null,

          stripe_session_id:
            session.id,

          donor_name:
            donorName,
        }
      );

    return json({
      success:
        true,

      paid:
        true,

      playerKey,

      baseballNumbers,

      donorName,

      updatedRows:
        soldRows.length,
    });

  } catch (error) {
    console.error(
      "Verify payment error:",
      error
    );

    return json(
      {
        success: false,

        error:
          error instanceof Error
            ? error.message
            : String(
                error
              ),
      },
      500
    );
  }
}

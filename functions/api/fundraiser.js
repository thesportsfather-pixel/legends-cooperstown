function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function supabaseGet(
  env,
  path
) {
  const response =
    await fetch(
      `${env.SUPABASE_URL}/rest/v1/${path}`,
      {
        method: "GET",

        headers: {
          apikey:
            env.SUPABASE_SERVICE_ROLE_KEY,

          authorization:
            `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,

          accept:
            "application/json",
        },
      }
    );

  const text =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `Supabase ${response.status}: ${text}`
    );
  }

  return text
    ? JSON.parse(text)
    : [];
}

export async function onRequestGet({
  request,
  env,
}) {
  try {
    if (
      !env.SUPABASE_URL ||
      !env.SUPABASE_SERVICE_ROLE_KEY
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

    const playerKey =
      (
        url.searchParams.get(
          "player"
        ) || ""
      ).trim();

    if (!playerKey) {
      return json(
        {
          success: false,
          error:
            "A player is required.",
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
          error:
            "Player not found.",
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
        )}&select=id,ball_number,amount_cents,status,donor_name,sold_at,stripe_session_id&order=ball_number.asc`
      );

    const normalized =
      baseballs.map(
        (ball) => ({
          ...ball,

          amount_cents:
            Number(
              ball.amount_cents
            ) ||
            Number(
              ball.ball_number ||
                0
            ) * 100,
        })
      );

    const raisedCents =
      normalized.reduce(
        (
          sum,
          ball
        ) => {
          return ball.status ===
            "sold"
            ? sum +
                Number(
                  ball.amount_cents ||
                    0
                )
            : sum;
        },
        0
      );

    const soldCount =
      normalized.filter(
        (ball) =>
          ball.status ===
          "sold"
      ).length;

    const goalCents =
      505000;

    return json({
      success: true,

      player: {
        id:
          player.id,

        key:
          player.player_key,

        name:
          player.player_name,

        number:
          player.player_number,
      },

      baseballs:
        normalized,

      totals: {
        raisedCents,

        raisedDollars:
          raisedCents /
          100,

        goalCents,

        goalDollars:
          goalCents /
          100,

        soldCount,

        remainingCount:
          Math.max(
            0,
            100 -
              soldCount
          ),
      },
    });

  } catch (error) {
    console.error(
      "Fundraiser API error:",
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

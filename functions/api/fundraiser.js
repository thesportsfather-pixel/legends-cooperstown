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
  const response = await fetch(
    `${env.SUPABASE_URL}/rest/v1/${path}`,
    {
      method: "GET",
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        accept: "application/json",
      },
    }
  );

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Supabase ${response.status}: ${text}`
    );
  }

  return text ? JSON.parse(text) : [];
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
          error: "Missing server configuration.",
        },
        500
      );
    }

    const url =
      new URL(request.url);

    const playerKey =
      (
        url.searchParams.get("player") ||
        ""
      ).trim();

    if (!playerKey) {
      return json(
        {
          success: false,
          error: "A player is required.",
        },
        400
      );
    }

    /* FIND LEGENDS TEAM */

    const teams =
      await supabaseGet(
        env,
        `teams?team_key=eq.legends-cooperstown&select=id,team_key,team_name&limit=1`
      );

    if (!teams.length) {
      return json(
        {
          success: false,
          error: "Legends team was not found.",
        },
        404
      );
    }

    const team =
      teams[0];

    /* FIND PLAYER USING team_id */

    const players =
      await supabaseGet(
        env,
        `players?team_id=eq.${encodeURIComponent(
          team.id
        )}&player_key=eq.${encodeURIComponent(
          playerKey
        )}&select=id,team_id,player_key,player_name,player_number&limit=1`
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

    /* GET PLAYER BASEBALLS */

    const baseballs =
      await supabaseGet(
        env,
        `baseballs?player_id=eq.${encodeURIComponent(
          player.id
        )}&select=id,ball_number,amount_cents,status,donor_name,sold_at,stripe_session_id&order=ball_number.asc`
      );

    const normalizedBaseballs =
      baseballs.map(
        (ball) => {
          const ballNumber =
            Number(
              ball.ball_number
            );

          const amountCents =
            Number(
              ball.amount_cents
            ) ||
            ballNumber * 100;

          return {
            id:
              ball.id,

            ball_number:
              ballNumber,

            amount_cents:
              amountCents,

            status:
              ball.status ||
              "available",

            donor_name:
              ball.donor_name ||
              null,

            sold_at:
              ball.sold_at ||
              null,

            stripe_session_id:
              ball.stripe_session_id ||
              null,
          };
        }
      );

    /* TOTALS */

    const raisedCents =
      normalizedBaseballs.reduce(
        (total, ball) => {
          if (
            ball.status ===
            "sold"
          ) {
            return (
              total +
              Number(
                ball.amount_cents ||
                0
              )
            );
          }

          return total;
        },
        0
      );

    const soldCount =
      normalizedBaseballs.filter(
        (ball) =>
          ball.status ===
          "sold"
      ).length;

    const goalCents =
      505000;

    return json({
      success: true,

      team: {
        id:
          team.id,

        key:
          team.team_key,

        name:
          team.team_name,
      },

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
        normalizedBaseballs,

      totals: {
        raisedCents,

        raisedDollars:
          raisedCents / 100,

        goalCents,

        goalDollars:
          goalCents / 100,

        soldCount,

        remainingCount:
          Math.max(
            0,
            100 - soldCount
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
            : String(error),
      },
      500
    );
  }
}

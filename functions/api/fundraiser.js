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

export async function onRequestGet({ request, env }) {
  try {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      return json(
        {
          success: false,
          error: "Missing Supabase configuration.",
        },
        500
      );
    }

    const url = new URL(request.url);

    const playerKey =
      url.searchParams.get("player") || "bryce-sosa";

    const players = await supabaseGet(
      env,
      `players?player_key=eq.${encodeURIComponent(
        playerKey
      )}&select=id,player_key,player_name&limit=1`
    );

    const player = players[0];

    if (!player) {
      return json(
        {
          success: false,
          error: "Player not found.",
        },
        404
      );
    }

    const baseballs = await supabaseGet(
      env,
      `baseballs?player_id=eq.${encodeURIComponent(
        player.id
      )}&select=id,ball_number,amount_cents,status,reserved_until,sold_at,donor_name&order=ball_number.asc`
    );

    const normalized = (baseballs || []).map((ball) => {
      if (ball.status === "reserved") {
        return {
          ...ball,
          status: "available",
          reserved_until: null,
        };
      }

      if (ball.status === "sold") {
        return {
          ...ball,
          donor_name:
            typeof ball.donor_name === "string" &&
            ball.donor_name.trim().length > 0
              ? ball.donor_name.trim()
              : "Anonymous",
        };
      }

      return ball;
    });

    const raisedCents = normalized
      .filter((ball) => ball.status === "sold")
      .reduce(
        (sum, ball) =>
          sum + Number(ball.amount_cents || 0),
        0
      );

    return json({
      success: true,

      player: {
        id: player.id,
        key: player.player_key,
        name: player.player_name,
      },

      baseballs: normalized,

      totals: {
        baseballCount: normalized.length,
        raisedCents,
        raisedDollars: raisedCents / 100,
        goalDollars: 5050,
      },
    });

  } catch (error) {
    console.error("Fundraiser API error:", error);

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

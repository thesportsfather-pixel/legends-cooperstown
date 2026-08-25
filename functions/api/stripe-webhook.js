function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,

    headers: {
      "content-type":
        "application/json; charset=utf-8",
    },
  });
}

function hexToBytes(hex) {
  if (
    !/^[0-9a-f]+$/i.test(
      hex
    ) ||
    hex.length % 2 !==
      0
  ) {
    return null;
  }

  const bytes =
    new Uint8Array(
      hex.length /
        2
    );

  for (
    let i = 0;
    i <
    bytes.length;
    i++
  ) {
    bytes[i] =
      parseInt(
        hex.slice(
          i * 2,
          i * 2 +
            2
        ),
        16
      );
  }

  return bytes;
}

function timingSafeEqual(
  a,
  b
) {
  if (
    a.length !==
    b.length
  ) {
    return false;
  }

  let diff = 0;

  for (
    let i = 0;
    i <
    a.length;
    i++
  ) {
    diff |=
      a[i] ^
      b[i];
  }

  return diff === 0;
}

async function verifyStripeSignature(
  rawBody,
  signatureHeader,
  secret
) {
  if (
    !signatureHeader ||
    !secret
  ) {
    return false;
  }

  const parts =
    signatureHeader.split(
      ","
    );

  const timestampPart =
    parts.find(
      (part) =>
        part.startsWith(
          "t="
        )
    );

  const signatures =
    parts
      .filter(
        (part) =>
          part.startsWith(
            "v1="
          )
      )
      .map(
        (part) =>
          part.slice(
            3
          )
      );

  if (
    !timestampPart ||
    !signatures.length
  ) {
    return false;
  }

  const timestamp =
    timestampPart.slice(
      2
    );

  const age =
    Math.abs(
      Date.now() /
        1000 -
        Number(
          timestamp
        )
    );

  if (
    !Number.isFinite(
      age
    ) ||
    age > 300
  ) {
    return false;
  }

  const encoder =
    new TextEncoder();

  const key =
    await crypto.subtle.importKey(
      "raw",

      encoder.encode(
        secret
      ),

      {
        name:
          "HMAC",

        hash:
          "SHA-256",
      },

      false,

      [
        "sign",
      ]
    );

  const signedPayload =
    `${timestamp}.${rawBody}`;

  const expectedBuffer =
    await crypto.subtle.sign(
      "HMAC",

      key,

      encoder.encode(
        signedPayload
      )
    );

  const expected =
    new Uint8Array(
      expectedBuffer
    );

  return signatures.some(
    (signature) => {
      const actual =
        hexToBytes(
          signature
        );

      return actual
        ? timingSafeEqual(
            expected,
            actual
          )
        : false;
    }
  );
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

export async function onRequestPost({
  request,
  env,
}) {
  try {
    if (
      !env.STRIPE_WEBHOOK_SECRET ||
      !env.SUPABASE_URL ||
      !env.SUPABASE_SERVICE_ROLE_KEY
    ) {
      return json(
        {
          success: false,
          error:
            "Missing webhook configuration.",
        },
        500
      );
    }

    const rawBody =
      await request.text();

    const signature =
      request.headers.get(
        "stripe-signature"
      );

    const valid =
      await verifyStripeSignature(
        rawBody,
        signature,
        env.STRIPE_WEBHOOK_SECRET
      );

    if (!valid) {
      return json(
        {
          success: false,
          error:
            "Invalid Stripe signature.",
        },
        400
      );
    }

    const event =
      JSON.parse(
        rawBody
      );

    if (
      event.type !==
      "checkout.session.completed"
    ) {
      return json({
        received:
          true,

        ignored:
          true,
      });
    }

    const session =
      event.data
        ?.object;

    if (
      !session ||
      session.payment_status !==
        "paid"
    ) {
      return json({
        received:
          true,

        ignored:
          true,
      });
    }

    const teamKey =
      session.metadata
        ?.team_key;

    const playerId =
      session.metadata
        ?.player_id;

    const baseballCsv =
      session.metadata
        ?.baseball_numbers;

    if (
      teamKey !==
        "legends-cooperstown" ||
      !playerId ||
      !baseballCsv
    ) {
      return json({
        received:
          true,

        ignored:
          true,
      });
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
      return json({
        received:
          true,

        ignored:
          true,
      });
    }

    const anonymous =
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
      anonymous ||
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
      received:
        true,

      updatedRows:
        soldRows.length,
    });

  } catch (error) {
    console.error(
      "Stripe webhook error:",
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

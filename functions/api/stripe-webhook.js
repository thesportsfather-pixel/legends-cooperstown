function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}


function hexToBytes(hex) {
  if (
    !/^[0-9a-f]+$/i.test(hex) ||
    hex.length % 2 !== 0
  ) {
    return null;
  }

  const bytes =
    new Uint8Array(
      hex.length / 2
    );

  for (
    let i = 0;
    i < bytes.length;
    i++
  ) {
    bytes[i] =
      parseInt(
        hex.slice(
          i * 2,
          i * 2 + 2
        ),
        16
      );
  }

  return bytes;
}


function timingSafeEqual(a, b) {
  if (
    !(a instanceof Uint8Array) ||
    !(b instanceof Uint8Array)
  ) {
    return false;
  }

  if (a.length !== b.length) {
    return false;
  }

  let diff = 0;

  for (
    let i = 0;
    i < a.length;
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
    signatureHeader
      .split(",")
      .map(
        part =>
          part.trim()
      );


  const timestampPart =
    parts.find(
      part =>
        part.startsWith("t=")
    );


  const signatures =
    parts
      .filter(
        part =>
          part.startsWith("v1=")
      )
      .map(
        part =>
          part.slice(3)
      );


  if (
    !timestampPart ||
    !signatures.length
  ) {
    return false;
  }


  const timestamp =
    timestampPart.slice(2);


  const timestampNumber =
    Number(timestamp);


  if (
    !Number.isFinite(
      timestampNumber
    )
  ) {
    return false;
  }


  const currentSeconds =
    Math.floor(
      Date.now() / 1000
    );


  if (
    Math.abs(
      currentSeconds -
      timestampNumber
    ) > 300
  ) {
    return false;
  }


  const signedPayload =
    `${timestamp}.${rawBody}`;


  const key =
    await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(
        secret
      ),
      {
        name: "HMAC",
        hash: "SHA-256",
      },
      false,
      ["sign"]
    );


  const digest =
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(
        signedPayload
      )
    );


  const expected =
    new Uint8Array(
      digest
    );


  return signatures.some(
    signature => {

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
        method: "PATCH",

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
          JSON.stringify(data),
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


    /*
      STRIPE REQUIRES THE ORIGINAL
      RAW REQUEST BODY
    */

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
      JSON.parse(rawBody);


    /*
      ONLY PROCESS SUCCESSFUL
      CHECKOUT SESSION EVENTS
    */

    if (
      event.type !==
      "checkout.session.completed"
    ) {
      return json({
        received: true,
        ignored: true,
        eventType:
          event.type,
      });
    }


    const session =
      event.data?.object;


    if (!session) {
      return json(
        {
          success: false,
          error:
            "Stripe session missing.",
        },
        400
      );
    }


    /*
      ONLY MARK BASEBALLS SOLD
      AFTER STRIPE REPORTS PAID
    */

    if (
      session.payment_status !==
      "paid"
    ) {
      return json({
        received: true,
        ignored: true,
        reason:
          "Payment is not marked paid.",
      });
    }


    const metadata =
      session.metadata || {};


    const teamKey =
      String(
        metadata.team_key ||
        ""
      ).trim();


    const playerId =
      String(
        metadata.player_id ||
        ""
      ).trim();


    const baseballCsv =
      String(
        metadata.baseball_numbers ||
        ""
      ).trim();


    /*
      ONLY PROCESS LEGENDS
    */

    if (
      teamKey !==
      "legends-cooperstown"
    ) {
      return json({
        received: true,
        ignored: true,
        reason:
          "Payment belongs to another team.",
        teamKey,
      });
    }


    if (
      !playerId ||
      !baseballCsv
    ) {
      return json(
        {
          success: false,
          error:
            "Required fundraiser metadata is missing.",
        },
        400
      );
    }


    const baseballNumbers =
      baseballCsv
        .split(",")
        .map(
          value =>
            Number(
              value.trim()
            )
        )
        .filter(
          value =>
            Number.isInteger(
              value
            ) &&
            value >= 1 &&
            value <= 100
        );


    if (
      !baseballNumbers.length
    ) {
      return json(
        {
          success: false,
          error:
            "No valid baseball numbers were found.",
        },
        400
      );
    }


    const anonymous =
      metadata.anonymous ===
      "true";


    let donorName =
      String(
        metadata.donor_name ||
        ""
      )
        .trim()
        .replace(
          /\s+/g,
          " "
        );


    if (
      anonymous ||
      !donorName
    ) {
      donorName =
        "Anonymous";
    }


    /*
      MARK BASEBALLS SOLD

      IMPORTANT:
      NO reserved_until FIELD HERE.
    */

    const soldRows =
      await supabasePatch(
        env,

        `baseballs` +
        `?player_id=eq.${encodeURIComponent(
          playerId
        )}` +
        `&ball_number=in.(${baseballNumbers.join(
          ","
        )})`,

        {
          status:
            "sold",

          donor_name:
            donorName,

          sold_at:
            new Date()
              .toISOString(),

          stripe_session_id:
            session.id,
        }
      );


    /*
      IF ZERO ROWS WERE UPDATED,
      RETURN AN ERROR INSTEAD OF
      PRETENDING EVERYTHING WORKED.
    */

    if (
      !Array.isArray(
        soldRows
      ) ||
      soldRows.length === 0
    ) {
      return json(
        {
          success: false,

          error:
            "Payment succeeded but no baseball rows were updated.",

          playerId,

          baseballNumbers,
        },
        500
      );
    }


    return json({
      received: true,

      success: true,

      paid: true,

      playerId,

      baseballNumbers,

      donorName,

      stripeSessionId:
        session.id,

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
            : String(error),
      },
      500
    );
  }
}

const express = require("express");

const app = express();

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

app.use((req, res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

app.get("/", (req, res) => {
  res.status(200).send("James Assist is running.");
});

function formatMinutes(seconds) {
  if (!seconds || seconds < 0) return "0 min";

  const minutes = Math.floor(seconds / 60);

  if (minutes < 60) {
    return `${minutes} min`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  return `${hours}h ${remainingMinutes}m`;
}

function calculateFRT(conversation) {
  const now = Math.floor(Date.now() / 1000);

  const createdAt = conversation.created_at;
  const firstAdminReplyAt =
    conversation.statistics?.first_admin_reply_at ||
    conversation.statistics?.first_contact_reply_at ||
    null;

  const targetSeconds = 30 * 60; // 30-minute FRT target for testing

  if (firstAdminReplyAt && createdAt) {
    return {
      status: "First reply already sent",
      waitingText: formatMinutes(firstAdminReplyAt - createdAt),
      risk: "Resolved"
    };
  }

  if (!createdAt) {
    return {
      status: "Unable to calculate yet",
      waitingText: "Unknown",
      risk: "Unknown"
    };
  }

  const waitingSeconds = now - createdAt;
  const secondsRemaining = targetSeconds - waitingSeconds;

  if (secondsRemaining <= 0) {
    return {
      status: "FRT breached",
      waitingText: formatMinutes(waitingSeconds),
      risk: "High"
    };
  }

  if (secondsRemaining <= 10 * 60) {
    return {
      status: `At risk in ${formatMinutes(secondsRemaining)}`,
      waitingText: formatMinutes(waitingSeconds),
      risk: "Medium"
    };
  }

  return {
    status: `Healthy — ${formatMinutes(secondsRemaining)} remaining`,
    waitingText: formatMinutes(waitingSeconds),
    risk: "Low"
  };
}

async function fetchIntercomConversation(conversationId) {
  const token = process.env.INTERCOM_ACCESS_TOKEN;

  if (!token) {
    throw new Error("Missing INTERCOM_ACCESS_TOKEN environment variable");
  }

  const response = await fetch(
    `https://api.intercom.io/conversations/${conversationId}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Intercom-Version": "2.11"
      }
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Intercom API error ${response.status}: ${errorText}`);
  }

  return response.json();
}

app.post("/intercom/initialize", async (req, res) => {
  console.log("Intercom initialize hit");

  const body = req.body || {};

  const conversationId =
    body.conversation?.id ||
    body.context?.conversation_id ||
    body.conversation_id ||
    null;

  const teammateName =
    body.admin?.name ||
    body.teammate?.name ||
    body.context?.admin_name ||
    "Unknown teammate";

  if (!conversationId) {
    return res.status(200).json({
      canvas: {
        content: {
          components: [
            {
              type: "text",
              text: "James Assist",
              style: "header"
            },
            {
              type: "text",
              text: "Conversation ID not found yet."
            },
            {
              type: "text",
              text: "The app is connected, but Intercom did not send a conversation ID in this request."
            }
          ]
        }
      }
    });
  }

  try {
    const conversation = await fetchIntercomConversation(conversationId);
    const frt = calculateFRT(conversation);

    const assignee =
      conversation.admin_assignee_id ||
      conversation.team_assignee_id ||
      "Unassigned / unknown";

    const state = conversation.state || "Unknown";
    const open = conversation.open === true ? "Open" : "Not open / unknown";

    res.status(200).json({
      canvas: {
        content: {
          components: [
            {
              type: "text",
              text: "James Assist",
              style: "header"
            },
            {
              type: "text",
              text: `Teammate: ${teammateName}`
            },
            {
              type: "text",
              text: `Conversation ID: ${conversationId}`
            },
            {
              type: "text",
              text: `FRT Status: ${frt.status}`
            },
            {
              type: "text",
              text: `Waiting time: ${frt.waitingText}`
            },
            {
              type: "text",
              text: `Risk: ${frt.risk}`
            },
            {
              type: "text",
              text: `Conversation state: ${state}`
            },
            {
              type: "text",
              text: `Open status: ${open}`
            },
            {
              type: "text",
              text: `Assignee ID: ${assignee}`
            },
            {
              type: "text",
              text: "Safe mode: read-only. No replies, tags, notes, or assignments are being changed."
            }
          ]
        }
      }
    });
  } catch (error) {
    console.error("James Assist error:", error.message);

    res.status(200).json({
      canvas: {
        content: {
          components: [
            {
              type: "text",
              text: "James Assist",
              style: "header"
            },
            {
              type: "text",
              text: "Connected, but could not fetch Intercom conversation details yet."
            },
            {
              type: "text",
              text: `Conversation ID: ${conversationId}`
            },
            {
              type: "text",
              text: `Error: ${error.message.substring(0, 250)}`
            },
            {
              type: "text",
              text: "Check the Render environment variable INTERCOM_ACCESS_TOKEN and make sure the app has Read conversations permission."
            }
          ]
        }
      }
    });
  }
});

app.post("/intercom/submit", (req, res) => {
  console.log("Intercom submit hit");

  res.status(200).json({
    canvas: {
      content: {
        components: [
          {
            type: "text",
            text: "James Assist",
            style: "header"
          },
          {
            type: "text",
            text: "Submit route is working safely."
          }
        ]
      }
    }
  });
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`James Assist running on port ${port}`);
});

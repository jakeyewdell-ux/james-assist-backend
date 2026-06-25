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

function stripHtml(input) {
  if (!input) return "";

  return String(input)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateText(text, maxLength = 220) {
  if (!text) return "No message preview found.";

  if (text.length <= maxLength) return text;

  return `${text.substring(0, maxLength)}...`;
}

function calculateFRT(conversation) {
  const now = Math.floor(Date.now() / 1000);

  const createdAt = conversation.created_at;
  const firstAdminReplyAt =
    conversation.statistics?.first_admin_reply_at ||
    conversation.statistics?.first_contact_reply_at ||
    null;

  const targetSeconds = 30 * 60; // 30-minute FRT target

  if (firstAdminReplyAt && createdAt) {
    return {
      status: "First reply already sent",
      waitingText: formatMinutes(firstAdminReplyAt - createdAt),
      risk: "Resolved",
      secondsRemaining: null,
      waitingSeconds: firstAdminReplyAt - createdAt,
      firstReplySent: true
    };
  }

  if (!createdAt) {
    return {
      status: "Unable to calculate yet",
      waitingText: "Unknown",
      risk: "Unknown",
      secondsRemaining: null,
      waitingSeconds: null,
      firstReplySent: false
    };
  }

  const waitingSeconds = now - createdAt;
  const secondsRemaining = targetSeconds - waitingSeconds;

  if (secondsRemaining <= 0) {
    return {
      status: "FRT breached",
      waitingText: formatMinutes(waitingSeconds),
      risk: "High",
      secondsRemaining,
      waitingSeconds,
      firstReplySent: false
    };
  }

  if (secondsRemaining <= 10 * 60) {
    return {
      status: `At risk in ${formatMinutes(secondsRemaining)}`,
      waitingText: formatMinutes(waitingSeconds),
      risk: "Medium",
      secondsRemaining,
      waitingSeconds,
      firstReplySent: false
    };
  }

  return {
    status: `Healthy — ${formatMinutes(secondsRemaining)} remaining`,
    waitingText: formatMinutes(waitingSeconds),
    risk: "Low",
    secondsRemaining,
    waitingSeconds,
    firstReplySent: false
  };
}

function getRecommendedAction(conversation, frt) {
  const isClosed = conversation.state === "closed";
  const isOpen = conversation.open === true;

  if (frt.firstReplySent && isClosed) {
    return "No FRT action needed — first reply was sent and the conversation is closed.";
  }

  if (frt.firstReplySent && isOpen) {
    return "First reply is complete. Review the latest customer message before closing.";
  }

  if (frt.risk === "High") {
    return "Reply now — FRT has breached or is past target.";
  }

  if (frt.risk === "Medium") {
    return "Reply soon — this conversation is close to FRT risk.";
  }

  if (frt.risk === "Low") {
    return "Healthy for now — keep an eye on it.";
  }

  return "Review manually — James Assist could not calculate the FRT status.";
}

function getPriority(frt) {
  if (frt.risk === "High") return "High";
  if (frt.risk === "Medium") return "Medium";
  if (frt.risk === "Low") return "Low";
  if (frt.risk === "Resolved") return "Resolved";
  return "Unknown";
}

function getLatestCustomerMessage(conversation) {
  const parts = conversation.conversation_parts?.conversation_parts || [];

  const customerParts = parts.filter((part) => {
    return part.author?.type === "user" || part.author?.type === "lead";
  });

  const latestPart = customerParts[customerParts.length - 1];

  const sourceBody =
    latestPart?.body ||
    conversation.source?.body ||
    conversation.source?.subject ||
    "";

  return truncateText(stripHtml(sourceBody));
}

function detectTopic(text) {
  const lower = text.toLowerCase();

  if (
    lower.includes("payout") ||
    lower.includes("withdraw") ||
    lower.includes("payment") ||
    lower.includes("paid") ||
    lower.includes("bank")
  ) {
    return "Payments / payouts";
  }

  if (
    lower.includes("verify") ||
    lower.includes("verification") ||
    lower.includes("id") ||
    lower.includes("document")
  ) {
    return "Verification";
  }

  if (
    lower.includes("subscription") ||
    lower.includes("cancel") ||
    lower.includes("refund") ||
    lower.includes("charged") ||
    lower.includes("billing")
  ) {
    return "Billing / subscription";
  }

  if (
    lower.includes("login") ||
    lower.includes("password") ||
    lower.includes("access") ||
    lower.includes("account")
  ) {
    return "Account access";
  }

  if (
    lower.includes("content") ||
    lower.includes("post") ||
    lower.includes("upload") ||
    lower.includes("video")
  ) {
    return "Content / uploads";
  }

  return "General support";
}

function getTopicSuggestion(topic, frt) {
  if (frt.risk === "High") {
    return "Prioritise this now because FRT is at risk.";
  }

  if (topic === "Payments / payouts") {
    return "Check payout/payment status before replying.";
  }

  if (topic === "Verification") {
    return "Check verification status and required document guidance.";
  }

  if (topic === "Billing / subscription") {
    return "Check billing, charge, subscription, or refund context.";
  }

  if (topic === "Account access") {
    return "Check account status and access history before replying.";
  }

  if (topic === "Content / uploads") {
    return "Check content/upload status and any moderation context.";
  }

  return "Review the conversation and reply using the relevant support process.";
}

function buildSuggestedReply(topic, latestCustomerMessage, frt) {
  if (!latestCustomerMessage || latestCustomerMessage === "No message preview found.") {
    return "Hey there, thanks so much for reaching out! I’ll take a look into this for you now and get back to you as soon as I can. 💚";
  }

  if (topic === "Payments / payouts") {
    return "Hey there, thanks so much for reaching out! I’m really sorry for the worry here. I’ll take a look into the payout/payment details for you now and help get this checked as quickly as possible. 💚";
  }

  if (topic === "Verification") {
    return "Hey there, thanks so much for reaching out! I’ll check the verification details for you and help confirm what’s needed next. 💚";
  }

  if (topic === "Billing / subscription") {
    return "Hey there, thanks so much for reaching out! I’m sorry for any confusion here. I’ll review the billing/subscription details and help get this looked into for you. 💚";
  }

  if (topic === "Account access") {
    return "Hey there, thanks so much for reaching out! I’m sorry you’re having trouble accessing your account. I’ll take a look and help guide you through the next steps. 💚";
  }

  if (topic === "Content / uploads") {
    return "Hey there, thanks so much for reaching out! I’ll check what’s happening with the content/upload issue and help get this looked into for you. 💚";
  }

  if (frt.risk === "High") {
    return "Hey there, thanks so much for waiting. I’m really sorry for the delay here — I’m checking this for you now and will help as quickly as possible. 💚";
  }

  return "Hey there, thanks so much for reaching out! I’ll take a look into this for you now and help get this sorted. 💚";
}

function buildAdminNote(topic, latestCustomerMessage) {
  const today = new Date().toISOString().slice(0, 10);

  return `${today} JY: Customer contacted support. Detected topic: ${topic}. Latest message preview: ${latestCustomerMessage}`;
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

    const priority = getPriority(frt);
    const recommendedAction = getRecommendedAction(conversation, frt);

    const latestCustomerMessage = getLatestCustomerMessage(conversation);
    const detectedTopic = detectTopic(latestCustomerMessage);
    const topicSuggestion = getTopicSuggestion(detectedTopic, frt);

    const suggestedReply = buildSuggestedReply(
      detectedTopic,
      latestCustomerMessage,
      frt
    );

    const adminNote = buildAdminNote(detectedTopic, latestCustomerMessage);

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
              text: `Priority: ${priority}`
            },
            {
              type: "text",
              text: `Recommended action: ${recommendedAction}`
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
              text: `Detected topic: ${detectedTopic}`
            },
            {
              type: "text",
              text: `Topic suggestion: ${topicSuggestion}`
            },
            {
              type: "text",
              text: `Suggested James reply: ${suggestedReply}`
            },
            {
              type: "text",
              text: `Suggested admin note: ${adminNote}`
            },
            {
              type: "text",
              text: `Latest customer message: ${latestCustomerMessage}`
            },
            {
              type: "text",
              text: `Risk: ${frt.risk}`
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

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

/**
 * SUPPORT TARGETS
 * Probation:
 * - Daily cases: 30–50/day
 * - FRT: under 15 minutes
 * - Time to first close: under 1h 20min
 * - CSAT: 65%
 */
const TARGETS = {
  frtSeconds: 15 * 60,
  firstCloseSeconds: 80 * 60,
  dailyCasesMin: 30,
  dailyCasesMax: 50,
  postProbationDailyCases: 60,
  csatTargetPercent: 65
};

function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) {
    return "Unknown";
  }

  if (seconds < 0) seconds = 0;

  const minutes = Math.floor(seconds / 60);

  if (minutes < 1) return "Under 1 min";

  if (minutes < 60) {
    return `${minutes} min`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  if (remainingMinutes === 0) {
    return `${hours}h`;
  }

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

function truncateText(text, maxLength = 180) {
  if (!text) return "No message preview found.";
  if (text.length <= maxLength) return text;
  return `${text.substring(0, maxLength)}...`;
}

function getAllConversationParts(conversation) {
  return conversation.conversation_parts?.conversation_parts || [];
}

function getLatestCustomerPart(conversation) {
  const parts = getAllConversationParts(conversation);

  const customerParts = parts.filter((part) => {
    return part.author?.type === "user" || part.author?.type === "lead";
  });

  if (customerParts.length > 0) {
    return customerParts[customerParts.length - 1];
  }

  if (conversation.source?.body || conversation.source?.subject) {
    return {
      body: conversation.source?.body || conversation.source?.subject,
      created_at: conversation.created_at,
      author: conversation.source?.author
    };
  }

  return null;
}

function getLatestCustomerMessage(conversation) {
  const latestPart = getLatestCustomerPart(conversation);

  const sourceBody =
    latestPart?.body ||
    conversation.source?.body ||
    conversation.source?.subject ||
    "";

  return truncateText(stripHtml(sourceBody));
}

function getCurrentCustomerWait(conversation) {
  const latestCustomerPart = getLatestCustomerPart(conversation);

  if (!latestCustomerPart?.created_at) {
    return {
      seconds: null,
      text: "Unknown"
    };
  }

  const now = Math.floor(Date.now() / 1000);
  const seconds = now - latestCustomerPart.created_at;

  return {
    seconds,
    text: formatDuration(seconds)
  };
}

function calculateFRT(conversation) {
  const now = Math.floor(Date.now() / 1000);

  const createdAt = conversation.created_at;
  const firstAdminReplyAt =
    conversation.statistics?.first_admin_reply_at ||
    conversation.statistics?.first_contact_reply_at ||
    null;

  if (firstAdminReplyAt && createdAt) {
    const frtSeconds = firstAdminReplyAt - createdAt;
    const hitTarget = frtSeconds <= TARGETS.frtSeconds;

    return {
      done: true,
      status: hitTarget
        ? `✅ Hit target — first reply in ${formatDuration(frtSeconds)}`
        : `🔴 Missed target — first reply in ${formatDuration(frtSeconds)}`,
      seconds: frtSeconds,
      remainingSeconds: null,
      risk: hitTarget ? "Resolved" : "Missed"
    };
  }

  if (!createdAt) {
    return {
      done: false,
      status: "⚪ Unable to calculate FRT",
      seconds: null,
      remainingSeconds: null,
      risk: "Unknown"
    };
  }

  const waitingSeconds = now - createdAt;
  const remainingSeconds = TARGETS.frtSeconds - waitingSeconds;

  if (remainingSeconds <= 0) {
    return {
      done: false,
      status: `🔴 FRT breached — waiting ${formatDuration(waitingSeconds)}`,
      seconds: waitingSeconds,
      remainingSeconds,
      risk: "High"
    };
  }

  if (remainingSeconds <= 5 * 60) {
    return {
      done: false,
      status: `🟡 FRT at risk — ${formatDuration(remainingSeconds)} left`,
      seconds: waitingSeconds,
      remainingSeconds,
      risk: "Medium"
    };
  }

  return {
    done: false,
    status: `🟢 Healthy — ${formatDuration(remainingSeconds)} left`,
    seconds: waitingSeconds,
    remainingSeconds,
    risk: "Low"
  };
}

function calculateFirstClose(conversation) {
  const now = Math.floor(Date.now() / 1000);

  const createdAt = conversation.created_at;
  const closedAt =
    conversation.statistics?.first_close_at ||
    conversation.statistics?.last_close_at ||
    conversation.closed_at ||
    null;

  if (!createdAt) {
    return {
      done: false,
      status: "⚪ Unable to calculate first close",
      elapsedText: "Unknown",
      risk: "Unknown"
    };
  }

  if (closedAt) {
    const closeSeconds = closedAt - createdAt;
    const hitTarget = closeSeconds <= TARGETS.firstCloseSeconds;

    return {
      done: true,
      status: hitTarget
        ? `✅ Hit target — first close in ${formatDuration(closeSeconds)}`
        : `🔴 Missed target — first close in ${formatDuration(closeSeconds)}`,
      elapsedText: formatDuration(closeSeconds),
      risk: hitTarget ? "Resolved" : "Missed"
    };
  }

  const elapsedSeconds = now - createdAt;
  const remainingSeconds = TARGETS.firstCloseSeconds - elapsedSeconds;

  if (remainingSeconds <= 0) {
    return {
      done: false,
      status: `🔴 First close target breached — open for ${formatDuration(elapsedSeconds)}`,
      elapsedText: formatDuration(elapsedSeconds),
      risk: "High"
    };
  }

  if (remainingSeconds <= 15 * 60) {
    return {
      done: false,
      status: `🟡 First close at risk — ${formatDuration(remainingSeconds)} left`,
      elapsedText: formatDuration(elapsedSeconds),
      risk: "Medium"
    };
  }

  return {
    done: false,
    status: `🟢 First close healthy — ${formatDuration(remainingSeconds)} left`,
    elapsedText: formatDuration(elapsedSeconds),
    risk: "Low"
  };
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

function getTopicSuggestion(topic, frt, firstClose) {
  if (frt.risk === "High") {
    return "Reply immediately to protect FRT.";
  }

  if (firstClose.risk === "High") {
    return "Prioritise resolution or close if fully solved.";
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
    return "Check upload/content status and moderation context.";
  }

  return "Review the conversation and reply using the relevant support process.";
}

function buildSuggestedReply(topic, latestCustomerMessage, frt) {
  if (!latestCustomerMessage || latestCustomerMessage === "No message preview found.") {
    return "Hey there, thanks so much for reaching out! I’ll take a look into this for you now and get back to you as soon as I can. 💚";
  }

  if (frt.risk === "High") {
    return "Hey there, thanks so much for waiting. I’m really sorry for the delay here — I’m checking this for you now and will help as quickly as possible. 💚";
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

  return "Hey there, thanks so much for reaching out! I’ll take a look into this for you now and help get this sorted. 💚";
}

function buildAdminNote(topic, latestCustomerMessage) {
  const today = new Date().toISOString().slice(0, 10);
  return `${today} JY: Customer contacted support. Detected topic: ${topic}. Latest message preview: ${latestCustomerMessage}`;
}

function getPriority(frt, firstClose, currentWait, conversation) {
  if (frt.risk === "High" || firstClose.risk === "High") {
    return {
      label: "🔴 High",
      summary: "Action needed now"
    };
  }

  if (frt.risk === "Medium" || firstClose.risk === "Medium") {
    return {
      label: "🟡 Medium",
      summary: "Needs attention soon"
    };
  }

  if (conversation.state === "closed") {
    return {
      label: "✅ Resolved",
      summary: "No active action needed"
    };
  }

  if (currentWait.seconds !== null && currentWait.seconds >= 10 * 60) {
    return {
      label: "🟡 Medium",
      summary: "Customer has been waiting"
    };
  }

  return {
    label: "🟢 Low",
    summary: "Healthy for now"
  };
}

function getRecommendedAction(conversation, frt, firstClose, currentWait) {
  const isClosed = conversation.state === "closed";
  const isOpen = conversation.open === true;

  if (isClosed) {
    return "No action needed — conversation is closed.";
  }

  if (frt.risk === "High") {
    return "Reply now to bring FRT back under control.";
  }

  if (frt.risk === "Medium") {
    return "Reply soon — FRT is close to the 15 min target.";
  }

  if (firstClose.risk === "High") {
    return "Prioritise resolution or close if the issue is fully solved.";
  }

  if (firstClose.risk === "Medium") {
    return "Move this toward resolution to protect first close time.";
  }

  if (isOpen && frt.done && currentWait.seconds !== null && currentWait.seconds >= 10 * 60) {
    return "Customer has replied — review and respond if needed.";
  }

  if (isOpen && frt.done) {
    return "First reply is complete. Review latest customer message and close when solved.";
  }

  return "Healthy for now — keep an eye on it.";
}

function getMetricScore(frt, firstClose) {
  let score = 100;

  if (frt.risk === "High") score -= 40;
  if (frt.risk === "Medium") score -= 20;
  if (frt.risk === "Missed") score -= 30;

  if (firstClose.risk === "High") score -= 35;
  if (firstClose.risk === "Medium") score -= 15;
  if (firstClose.risk === "Missed") score -= 25;

  if (score < 0) score = 0;

  if (score >= 85) return `🟢 ${score}/100`;
  if (score >= 60) return `🟡 ${score}/100`;
  return `🔴 ${score}/100`;
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

function buildCanvas(components) {
  return {
    canvas: {
      content: {
        components
      }
    }
  };
}

async function renderJamesAssist(req, res) {
  console.log("James Assist render hit");

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
    return res.status(200).json(
      buildCanvas([
        {
          type: "text",
          text: "James Assist",
          style: "header"
        },
        {
          type: "text",
          text: "⚪ Conversation ID not found yet."
        },
        {
          type: "text",
          text: "The app is connected, but Intercom did not send a conversation ID in this request."
        }
      ])
    );
  }

  try {
    const conversation = await fetchIntercomConversation(conversationId);

    const frt = calculateFRT(conversation);
    const firstClose = calculateFirstClose(conversation);
    const currentWait = getCurrentCustomerWait(conversation);

    const latestCustomerMessage = getLatestCustomerMessage(conversation);
    const detectedTopic = detectTopic(latestCustomerMessage);
    const topicSuggestion = getTopicSuggestion(detectedTopic, frt, firstClose);

    const priority = getPriority(frt, firstClose, currentWait, conversation);
    const recommendedAction = getRecommendedAction(
      conversation,
      frt,
      firstClose,
      currentWait
    );

    const suggestedReply = buildSuggestedReply(
      detectedTopic,
      latestCustomerMessage,
      frt
    );

    const adminNote = buildAdminNote(detectedTopic, latestCustomerMessage);

    const state = conversation.state || "Unknown";
    const open = conversation.open === true ? "Open" : "Not open";
    const metricScore = getMetricScore(frt, firstClose);

    return res.status(200).json(
      buildCanvas([
        {
          type: "text",
          text: "James Assist",
          style: "header"
        },

        {
          type: "text",
          text: `${priority.label} — ${priority.summary}`
        },
        {
          type: "text",
          text: `🎯 Metrics score: ${metricScore}`
        },
        {
          type: "text",
          text: `⚡ Action: ${recommendedAction}`
        },

        {
          type: "text",
          text: "—"
        },

        {
          type: "text",
          text: `⏱ FRT target: under 15 min`
        },
        {
          type: "text",
          text: `FRT: ${frt.status}`
        },
        {
          type: "text",
          text: `Current customer wait: ${currentWait.text}`
        },
        {
          type: "text",
          text: `First close target: under 1h 20m`
        },
        {
          type: "text",
          text: `First close: ${firstClose.status}`
        },

        {
          type: "text",
          text: "—"
        },

        {
          type: "text",
          text: `🧭 Topic: ${detectedTopic}`
        },
        {
          type: "text",
          text: `Next check: ${topicSuggestion}`
        },
        {
          type: "text",
          text: `Customer said: ${latestCustomerMessage}`
        },

        {
          type: "text",
          text: "—"
        },

        {
          type: "text",
          text: `💬 Suggested James reply: ${suggestedReply}`
        },
        {
          type: "text",
          text: `📝 Suggested admin note: ${adminNote}`
        },

        {
          type: "text",
          text: "—"
        },

        {
          type: "text",
          text: `Status: ${state} / ${open}`
        },
        {
          type: "text",
          text: `Teammate: ${teammateName}`
        },
        {
          type: "text",
          text: `Conversation: ${conversationId}`
        },
        {
          type: "text",
          text: `Targets: 30–50 cases/day · FRT <15m · First close <1h20m · CSAT 65%`
        },
        {
          type: "text",
          text: "Safe mode: read-only. Nothing is sent or changed."
        },
        {
          type: "button",
          id: "refresh_metrics",
          label: "Refresh metrics",
          style: "secondary",
          action: {
            type: "submit"
          }
        }
      ])
    );
  } catch (error) {
    console.error("James Assist error:", error.message);

    return res.status(200).json(
      buildCanvas([
        {
          type: "text",
          text: "James Assist",
          style: "header"
        },
        {
          type: "text",
          text: "🔴 Connected, but could not fetch Intercom conversation details yet."
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
          text: "Check INTERCOM_ACCESS_TOKEN and Read conversations permission."
        }
      ])
    );
  }
}

app.post("/intercom/initialize", renderJamesAssist);
app.post("/intercom/submit", renderJamesAssist);

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`James Assist running on port ${port}`);
});

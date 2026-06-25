const express = require("express");

const app = express();

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

app.use((req, res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

app.get("/", (req, res) => {
  res.status(200).send("AgentVue is running.");
});

/**
 * AGENTVUE TARGETS
 *
 * Probation:
 * - Daily cases: 30–50/day
 * - FRT: under 15 minutes
 * - Time to first close: under 1h 20min
 * - CSAT: 65%
 *
 * Note:
 * - Live exact daily case counting is paused because Intercom updated_at can overcount.
 * - FRT, first close, customer wait, topic, reply, and admin note remain active.
 */
const TARGETS = {
  frtSeconds: 15 * 60,
  firstCloseSeconds: 80 * 60,
  dailyCasesMin: Number(process.env.DAILY_CASE_TARGET_MIN || 30),
  dailyCasesMax: Number(process.env.DAILY_CASE_TARGET_MAX || 50),
  postProbationDailyCases: Number(process.env.POST_PROBATION_DAILY_CASES || 60),
  csatTargetPercent: Number(process.env.CSAT_TARGET_PERCENT || 65),
  shiftStartHourICT: Number(process.env.SHIFT_START_HOUR_ICT || 0),
  shiftEndHourICT: Number(process.env.SHIFT_END_HOUR_ICT || 8)
};

function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) {
    return "Unknown";
  }

  if (seconds < 0) seconds = 0;

  const minutes = Math.floor(seconds / 60);

  if (minutes < 1) return "Under 1 min";
  if (minutes < 60) return `${minutes} min`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  if (remainingMinutes === 0) return `${hours}h`;

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

function truncateText(text, maxLength = 110) {
  if (!text) return "No message preview found.";
  if (text.length <= maxLength) return text;
  return `${text.substring(0, maxLength)}...`;
}

function getAllConversationParts(conversation) {
  return conversation.conversation_parts?.conversation_parts || [];
}

function getSourceItem(conversation) {
  if (!conversation.source) return null;

  return {
    body: conversation.source.body || conversation.source.subject || "",
    created_at: conversation.created_at,
    author: conversation.source.author || null,
    author_type:
      conversation.source.author?.type ||
      conversation.source.type ||
      "user"
  };
}

function getLatestConversationItem(conversation) {
  const sourceItem = getSourceItem(conversation);

  const parts = getAllConversationParts(conversation).map((part) => ({
    body: part.body || "",
    created_at: part.created_at,
    author: part.author || null,
    author_type: part.author?.type || "unknown",
    part_type: part.part_type || part.type || "unknown"
  }));

  const items = [];

  if (sourceItem?.created_at) {
    items.push(sourceItem);
  }

  for (const part of parts) {
    if (part.created_at) {
      items.push(part);
    }
  }

  if (items.length === 0) return null;

  return items.sort((a, b) => a.created_at - b.created_at)[items.length - 1];
}

function getLatestCustomerPart(conversation) {
  const items = [];

  const sourceItem = getSourceItem(conversation);

  if (
    sourceItem?.created_at &&
    (
      sourceItem.author_type === "user" ||
      sourceItem.author_type === "lead" ||
      sourceItem.author_type === "contact"
    )
  ) {
    items.push(sourceItem);
  }

  const parts = getAllConversationParts(conversation);

  for (const part of parts) {
    const authorType = part.author?.type;

    if (
      part.created_at &&
      (
        authorType === "user" ||
        authorType === "lead" ||
        authorType === "contact"
      )
    ) {
      items.push({
        body: part.body || "",
        created_at: part.created_at,
        author: part.author || null,
        author_type: authorType
      });
    }
  }

  if (items.length === 0) return null;

  return items.sort((a, b) => a.created_at - b.created_at)[items.length - 1];
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

function getFullLatestCustomerMessage(conversation) {
  const latestPart = getLatestCustomerPart(conversation);

  const sourceBody =
    latestPart?.body ||
    conversation.source?.body ||
    conversation.source?.subject ||
    "";

  return stripHtml(sourceBody) || "No customer message found.";
}

function getCurrentCustomerWait(conversation) {
  if (conversation.state === "closed" || conversation.open !== true) {
    return {
      seconds: 0,
      text: "Stopped — closed"
    };
  }

  const latestCustomerPart = getLatestCustomerPart(conversation);

  if (!latestCustomerPart?.created_at) {
    return {
      seconds: null,
      text: "Unknown"
    };
  }

  const latestItem = getLatestConversationItem(conversation);

  if (
    latestItem &&
    latestItem.author_type !== "user" &&
    latestItem.author_type !== "lead" &&
    latestItem.author_type !== "contact"
  ) {
    return {
      seconds: 0,
      text: "Stopped — agent replied"
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
      label: hitTarget ? "✅ FRT hit" : "🔴 FRT missed",
      status: `First reply in ${formatDuration(frtSeconds)}`,
      seconds: frtSeconds,
      remainingSeconds: null,
      risk: hitTarget ? "Resolved" : "Missed"
    };
  }

  if (!createdAt) {
    return {
      done: false,
      label: "⚪ FRT unknown",
      status: "Unable to calculate",
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
      label: "🔴 FRT breached",
      status: `Waiting ${formatDuration(waitingSeconds)}`,
      seconds: waitingSeconds,
      remainingSeconds,
      risk: "High"
    };
  }

  if (remainingSeconds <= 5 * 60) {
    return {
      done: false,
      label: "🟡 FRT risk",
      status: `${formatDuration(remainingSeconds)} left`,
      seconds: waitingSeconds,
      remainingSeconds,
      risk: "Medium"
    };
  }

  return {
    done: false,
    label: "🟢 FRT healthy",
    status: `${formatDuration(remainingSeconds)} left`,
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
      label: "⚪ Close unknown",
      status: "Unable to calculate",
      elapsedText: "Unknown",
      risk: "Unknown"
    };
  }

  if (closedAt) {
    const closeSeconds = closedAt - createdAt;
    const hitTarget = closeSeconds <= TARGETS.firstCloseSeconds;

    return {
      done: true,
      label: hitTarget ? "✅ Close hit" : "🔴 Close missed",
      status: `Closed in ${formatDuration(closeSeconds)}`,
      elapsedText: formatDuration(closeSeconds),
      risk: hitTarget ? "Resolved" : "Missed"
    };
  }

  const elapsedSeconds = now - createdAt;
  const remainingSeconds = TARGETS.firstCloseSeconds - elapsedSeconds;

  if (remainingSeconds <= 0) {
    return {
      done: false,
      label: "🔴 Close breached",
      status: `Open ${formatDuration(elapsedSeconds)}`,
      elapsedText: formatDuration(elapsedSeconds),
      risk: "High"
    };
  }

  if (remainingSeconds <= 15 * 60) {
    return {
      done: false,
      label: "🟡 Close risk",
      status: `${formatDuration(remainingSeconds)} left`,
      elapsedText: formatDuration(elapsedSeconds),
      risk: "Medium"
    };
  }

  return {
    done: false,
    label: "🟢 Close healthy",
    status: `${formatDuration(remainingSeconds)} left`,
    elapsedText: formatDuration(elapsedSeconds),
    risk: "Low"
  };
}

function detectTopic(text) {
  const lower = text.toLowerCase();

  if (
    lower.includes("bio") ||
    lower.includes("profile") ||
    lower.includes("updated my bio") ||
    lower.includes("feedback") ||
    lower.includes("concerns mentioned") ||
    lower.includes("review my bio") ||
    lower.includes("bio updated")
  ) {
    return "Bio / profile compliance";
  }

  if (
    lower.includes("payout") ||
    lower.includes("withdraw") ||
    lower.includes("withdrawal") ||
    lower.includes("payment") ||
    lower.includes("paid") ||
    lower.includes("bank") ||
    lower.includes("masspay")
  ) {
    return "Payments / payouts";
  }

  if (
    lower.includes("verify") ||
    lower.includes("verification") ||
    lower.includes("id") ||
    lower.includes("document") ||
    lower.includes("kyc") ||
    lower.includes("impersonating") ||
    lower.includes("hacked") ||
    lower.includes("compromised") ||
    lower.includes("ownership")
  ) {
    return "Verification / security";
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
    lower.includes("account") ||
    lower.includes("invalid credentials")
  ) {
    return "Account access";
  }

  if (
    lower.includes("content") ||
    lower.includes("post") ||
    lower.includes("upload") ||
    lower.includes("video") ||
    lower.includes("media") ||
    lower.includes("co-creator") ||
    lower.includes("model release")
  ) {
    return "Content / uploads";
  }

  return "General support";
}

function getTopicSuggestion(topic, frt, firstClose) {
  if (frt.risk === "High") return "Reply immediately to protect FRT.";
  if (firstClose.risk === "High") return "Prioritise resolution or close if solved.";

  if (topic === "Bio / profile compliance") {
    return "Check updated bio/profile against the previous concern.";
  }

  if (topic === "Payments / payouts") return "Check payout/payment status.";
  if (topic === "Verification / security") return "Check verification/security guidance.";
  if (topic === "Billing / subscription") return "Check billing/subscription context.";
  if (topic === "Account access") return "Check account status/access history.";
  if (topic === "Content / uploads") return "Check content/upload context.";

  return "Review latest message and apply the relevant process.";
}

function buildSuggestedReply(topic, latestCustomerMessage, fullLatestCustomerMessage, frt) {
  if (frt.risk === "High") {
    return "Hey there, thanks so much for waiting. I’m really sorry for the delay here — I’m checking this for you now and will help as quickly as possible. 💚";
  }

  if (topic === "Bio / profile compliance") {
    return "Hey there, thanks so much for getting back to us and for updating your bio. I’ll review the changes against the feedback that was previously shared and check whether anything else is needed. If everything now looks aligned, we’ll be able to advise on the next step from here. 💚";
  }

  if (topic === "Payments / payouts") {
    return "Hey there, thanks so much for reaching out. I’m sorry for the worry here — I’ll check the payout/payment details for you now and confirm what’s happening as clearly as possible. 💚";
  }

  if (topic === "Verification / security") {
    return "Hey there, thanks so much for reaching out. I’m really sorry this is causing concern. I’ll review the verification/security details carefully and help confirm what’s needed next. 💚";
  }

  if (topic === "Billing / subscription") {
    return "Hey there, thanks so much for reaching out. I’m sorry for any confusion here — I’ll review the billing/subscription details and help get this checked for you. 💚";
  }

  if (topic === "Account access") {
    return "Hey there, thanks so much for reaching out. I’m sorry you’re having trouble accessing your account. I’ll take a look into this now and help guide you through the next steps. 💚";
  }

  if (topic === "Content / uploads") {
    return "Hey there, thanks so much for reaching out. I’ll check the content/upload details for you now and help confirm what’s needed next. 💚";
  }

  return "Hey there, thanks so much for reaching out. I’ll review the details you’ve sent over and help get this checked for you. 💚";
}

function buildFTRAcknowledgement(topic, frt) {
  if (frt.risk === "High") {
    return "Hey there, thanks so much for waiting. I’m really sorry for the delay here — I’m checking this for you now and will help as quickly as possible. 💚";
  }

  if (frt.risk === "Medium") {
    return "Hey there, thanks so much for reaching out! I’m taking a look into this for you now and will help get this checked as quickly as possible. 💚";
  }

  if (topic === "Bio / profile compliance") {
    return "Hey there, thanks so much for getting back to us and for updating your bio. I’m checking this for you now and will confirm the next step as soon as I can. 💚";
  }

  if (topic === "Payments / payouts") {
    return "Hey there, thanks so much for reaching out! I’m checking the payout/payment details for you now. 💚";
  }

  if (topic === "Verification / security") {
    return "Hey there, thanks so much for reaching out! I’m checking the verification/security details for you now. 💚";
  }

  if (topic === "Billing / subscription") {
    return "Hey there, thanks so much for reaching out! I’m checking the billing/subscription details for you now. 💚";
  }

  if (topic === "Account access") {
    return "Hey there, thanks so much for reaching out! I’m checking the account access details for you now. 💚";
  }

  if (topic === "Content / uploads") {
    return "Hey there, thanks so much for reaching out! I’m checking the content/upload details for you now. 💚";
  }

  return "Hey there, thanks so much for reaching out! I’m checking this for you now and will help get this sorted. 💚";
}

function buildAdminNote(topic, latestCustomerMessage, fullLatestCustomerMessage) {
  const today = new Date().toISOString().slice(0, 10);

  if (topic === "Bio / profile compliance") {
    return `${today} JY: Customer confirmed they updated their bio following previous feedback and requested review/next steps. Need to check updated profile/bio against prior concern. Latest message: ${fullLatestCustomerMessage}`;
  }

  if (topic === "Payments / payouts") {
    return `${today} JY: Customer contacted support regarding payout/payment issue. Need to review payout status, provider status, and account eligibility. Latest message: ${fullLatestCustomerMessage}`;
  }

  if (topic === "Verification / security") {
    return `${today} JY: Customer contacted support regarding verification/security concern. Need to verify identity/account status before sharing account-specific details. Latest message: ${fullLatestCustomerMessage}`;
  }

  if (topic === "Account access") {
    return `${today} JY: Customer contacted support regarding account access/login issue. Need to review account status and advise next safe steps. Latest message: ${fullLatestCustomerMessage}`;
  }

  if (topic === "Content / uploads") {
    return `${today} JY: Customer contacted support regarding content/upload or compliance issue. Need to review account/content status and advise next steps. Latest message: ${fullLatestCustomerMessage}`;
  }

  return `${today} JY: Customer contacted support. Topic: ${topic}. Latest message: ${fullLatestCustomerMessage}`;
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
      summary: "No active action"
    };
  }

  if (currentWait.seconds !== null && currentWait.seconds >= 10 * 60) {
    return {
      label: "🟡 Medium",
      summary: "Customer waiting"
    };
  }

  return {
    label: "🟢 Low",
    summary: "Healthy"
  };
}

function getRecommendedAction(conversation, frt, firstClose, currentWait) {
  const isClosed = conversation.state === "closed";
  const isOpen = conversation.open === true;

  if (frt.risk === "High") return "Reply now to protect FRT.";
  if (frt.risk === "Medium") return "Reply soon — FRT is near 15 min.";
  if (firstClose.risk === "High") return "Prioritise resolution or close if solved.";
  if (firstClose.risk === "Medium") return "Move toward resolution.";
  if (isClosed) return "No action — conversation is closed.";

  if (isOpen && frt.done && currentWait.seconds !== null && currentWait.seconds >= 10 * 60) {
    return "Customer replied — review and respond if needed.";
  }

  if (isOpen && frt.done) return "First reply complete. Close when solved.";

  return "Healthy for now.";
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

async function sendIntercomReply(conversationId, body) {
  const token = process.env.INTERCOM_ACCESS_TOKEN;
  const adminId = process.env.JAMES_ADMIN_ID;

  if (!token) {
    throw new Error("Missing INTERCOM_ACCESS_TOKEN environment variable");
  }

  if (!adminId) {
    throw new Error("Missing JAMES_ADMIN_ID environment variable");
  }

  const response = await fetch(
    `https://api.intercom.io/conversations/${conversationId}/reply`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "Intercom-Version": "2.11"
      },
      body: JSON.stringify({
        message_type: "comment",
        type: "admin",
        admin_id: String(adminId),
        body
      })
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Intercom reply error ${response.status}: ${errorText}`);
  }

  return response.json();
}

function canSendFTRAck(conversation, data) {
  const jamesAdminId = String(process.env.JAMES_ADMIN_ID || "");
  const assignedAdminId = String(conversation.admin_assignee_id || "");

  if (!jamesAdminId) {
    return {
      allowed: false,
      reason: "JAMES_ADMIN_ID is missing in Render."
    };
  }

  if (conversation.state === "closed") {
    return {
      allowed: false,
      reason: "Conversation is closed."
    };
  }

  if (conversation.open !== true) {
    return {
      allowed: false,
      reason: "Conversation is not open."
    };
  }

  if (assignedAdminId !== jamesAdminId) {
    return {
      allowed: false,
      reason: `Conversation is not assigned to James. Current assignee ID: ${assignedAdminId || "unknown"}`
    };
  }

  const latestItem = getLatestConversationItem(conversation);

  if (!latestItem) {
    return {
      allowed: false,
      reason: "No latest conversation message found."
    };
  }

  const latestAuthorType = latestItem.author_type;

  if (
    latestAuthorType !== "user" &&
    latestAuthorType !== "lead" &&
    latestAuthorType !== "contact"
  ) {
    return {
      allowed: false,
      reason: `Latest message is not from a customer. Latest author type: ${latestAuthorType}`
    };
  }

  const parts = getAllConversationParts(conversation);
  const ackText = stripHtml(data.frtAcknowledgement).toLowerCase();

  const duplicateAck = parts.some((part) => {
    const authorType = part.author?.type;
    const body = stripHtml(part.body || "").toLowerCase();

    return authorType === "admin" && body.includes(ackText.slice(0, 60));
  });

  if (duplicateAck) {
    return {
      allowed: false,
      reason: "This acknowledgement appears to have already been sent."
    };
  }

  return {
    allowed: true,
    reason: "Safe to send acknowledgement."
  };
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

function getConversationIdFromBody(body) {
  return (
    body.conversation?.id ||
    body.context?.conversation_id ||
    body.conversation_id ||
    null
  );
}

function getTeammateNameFromBody(body) {
  return (
    body.admin?.name ||
    body.teammate?.name ||
    body.context?.admin_name ||
    "Unknown teammate"
  );
}

function getSubmittedComponentId(body) {
  return (
    body.component_id ||
    body.component?.id ||
    body.input_values?.component_id ||
    body.context?.component_id ||
    null
  );
}

async function buildConversationData(conversationId) {
  const conversation = await fetchIntercomConversation(conversationId);

  const frt = calculateFRT(conversation);
  const firstClose = calculateFirstClose(conversation);
  const currentWait = getCurrentCustomerWait(conversation);

  const latestCustomerMessage = getLatestCustomerMessage(conversation);
  const fullLatestCustomerMessage = getFullLatestCustomerMessage(conversation);

  const detectedTopic = detectTopic(fullLatestCustomerMessage);
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
    fullLatestCustomerMessage,
    frt
  );

  const frtAcknowledgement = buildFTRAcknowledgement(
    detectedTopic,
    frt
  );

  const adminNote = buildAdminNote(
    detectedTopic,
    latestCustomerMessage,
    fullLatestCustomerMessage
  );

  const state = conversation.state || "Unknown";
  const open = conversation.open === true ? "Open" : "Not open";
  const metricScore = getMetricScore(frt, firstClose);

  return {
    conversation,
    frt,
    firstClose,
    currentWait,
    latestCustomerMessage,
    fullLatestCustomerMessage,
    detectedTopic,
    topicSuggestion,
    priority,
    recommendedAction,
    suggestedReply,
    frtAcknowledgement,
    adminNote,
    state,
    open,
    metricScore
  };
}

function renderShiftSummary() {
  return [
    {
      type: "text",
      text: "📊 Cases: exact count paused"
    },
    {
      type: "text",
      text: "Use Intercom report for final close count"
    }
  ];
}

function renderReplyPanel(data, conversationId) {
  return buildCanvas([
    {
      type: "text",
      text: "AgentVue",
      style: "header"
    },
    {
      type: "text",
      text: `💬 Suggested reply — ${data.detectedTopic}`
    },
    {
      type: "text",
      text: data.suggestedReply
    },
    {
      type: "button",
      id: "send_frt_ack",
      label: "Send FRT acknowledgement",
      style: "primary",
      action: {
        type: "submit"
      }
    },
    {
      type: "button",
      id: "back_to_main",
      label: "Back",
      style: "secondary",
      action: {
        type: "submit"
      }
    },
    {
      type: "text",
      text: `Conversation: ${conversationId}`
    }
  ]);
}

function renderNotePanel(data, conversationId) {
  return buildCanvas([
    {
      type: "text",
      text: "AgentVue",
      style: "header"
    },
    {
      type: "text",
      text: `📝 Admin note — ${data.detectedTopic}`
    },
    {
      type: "text",
      text: data.adminNote
    },
    {
      type: "button",
      id: "back_to_main",
      label: "Back",
      style: "secondary",
      action: {
        type: "submit"
      }
    },
    {
      type: "text",
      text: `Conversation: ${conversationId}`
    }
  ]);
}

function renderCaseDetailsPanel(data, conversationId) {
  return buildCanvas([
    {
      type: "text",
      text: "AgentVue",
      style: "header"
    },
    {
      type: "text",
      text: `🧭 Topic: ${data.detectedTopic}`
    },
    {
      type: "text",
      text: `Recommended check: ${data.topicSuggestion}`
    },
    {
      type: "text",
      text: `Latest customer message: ${data.fullLatestCustomerMessage}`
    },
    {
      type: "text",
      text: `FRT: ${data.frt.label} — ${data.frt.status}`
    },
    {
      type: "text",
      text: `First close: ${data.firstClose.label} — ${data.firstClose.status}`
    },
    {
      type: "text",
      text: `Customer wait: ${data.currentWait.text}`
    },
    {
      type: "button",
      id: "back_to_main",
      label: "Back",
      style: "secondary",
      action: {
        type: "submit"
      }
    },
    {
      type: "text",
      text: `Conversation: ${conversationId}`
    }
  ]);
}

function renderMainPanel(data) {
  return buildCanvas([
    {
      type: "text",
      text: "AgentVue",
      style: "header"
    },
    {
      type: "text",
      text: `${data.priority.label} — ${data.priority.summary}`
    },
    {
      type: "text",
      text: `🎯 ${data.metricScore} · ${data.recommendedAction}`
    },

    {
      type: "text",
      text: "━━━━━━━━━━━━"
    },

    ...renderShiftSummary(),

    {
      type: "text",
      text: "━━━━━━━━━━━━"
    },

    {
      type: "text",
      text: `⏱ ${data.frt.label}: ${data.frt.status}`
    },
    {
      type: "text",
      text: `🏁 ${data.firstClose.label}: ${data.firstClose.status}`
    },
    {
      type: "text",
      text: `👤 Wait: ${data.currentWait.text}`
    },

    {
      type: "text",
      text: "━━━━━━━━━━━━"
    },

    {
      type: "text",
      text: `🧭 ${data.detectedTopic}`
    },
    {
      type: "text",
      text: `Next: ${data.topicSuggestion}`
    },
    {
      type: "text",
      text: "💬 Suggested reply ready"
    },
    {
      type: "text",
      text: "📝 Admin note ready"
    },

    {
      type: "button",
      id: "show_reply",
      label: "Show reply",
      style: "secondary",
      action: {
        type: "submit"
      }
    },
    {
      type: "button",
      id: "show_note",
      label: "Show note",
      style: "secondary",
      action: {
        type: "submit"
      }
    },
    {
      type: "button",
      id: "show_details",
      label: "Show details",
      style: "secondary",
      action: {
        type: "submit"
      }
    },
    {
      type: "button",
      id: "send_frt_ack",
      label: "Send FRT acknowledgement",
      style: "primary",
      action: {
        type: "submit"
      }
    },
    {
      type: "button",
      id: "refresh_metrics",
      label: "Refresh",
      style: "secondary",
      action: {
        type: "submit"
      }
    }
  ]);
}

function renderAckSentPanel(data, conversationId) {
  return buildCanvas([
    {
      type: "text",
      text: "AgentVue",
      style: "header"
    },
    {
      type: "text",
      text: "✅ FRT acknowledgement sent"
    },
    {
      type: "text",
      text: `Message: ${data.frtAcknowledgement}`
    },
    {
      type: "button",
      id: "refresh_metrics",
      label: "Refresh",
      style: "secondary",
      action: {
        type: "submit"
      }
    },
    {
      type: "text",
      text: `Conversation: ${conversationId}`
    }
  ]);
}

function renderAckBlockedPanel(reason, conversationId) {
  return buildCanvas([
    {
      type: "text",
      text: "AgentVue",
      style: "header"
    },
    {
      type: "text",
      text: "⚠️ Acknowledgement not sent"
    },
    {
      type: "text",
      text: reason
    },
    {
      type: "text",
      text: "No message was sent or changed."
    },
    {
      type: "button",
      id: "refresh_metrics",
      label: "Back to metrics",
      style: "secondary",
      action: {
        type: "submit"
      }
    },
    {
      type: "text",
      text: `Conversation: ${conversationId}`
    }
  ]);
}

async function renderAgentVue(req, res) {
  console.log("AgentVue render hit");

  const body = req.body || {};
  const conversationId = getConversationIdFromBody(body);
  const componentId = getSubmittedComponentId(body);

  if (!conversationId) {
    return res.status(200).json(
      buildCanvas([
        {
          type: "text",
          text: "AgentVue",
          style: "header"
        },
        {
          type: "text",
          text: "⚪ Conversation ID not found yet."
        },
        {
          type: "text",
          text: "The app is connected, but Intercom did not send a conversation ID."
        }
      ])
    );
  }

  try {
    const data = await buildConversationData(conversationId);

    if (componentId === "show_reply") {
      return res.status(200).json(
        renderReplyPanel(data, conversationId)
      );
    }

    if (componentId === "show_note") {
      return res.status(200).json(
        renderNotePanel(data, conversationId)
      );
    }

    if (componentId === "show_details") {
      return res.status(200).json(
        renderCaseDetailsPanel(data, conversationId)
      );
    }

    if (componentId === "back_to_main" || componentId === "refresh_metrics") {
      return res.status(200).json(
        renderMainPanel(data)
      );
    }

    if (componentId === "send_frt_ack") {
      const safety = canSendFTRAck(data.conversation, data);

      if (!safety.allowed) {
        return res.status(200).json(
          renderAckBlockedPanel(safety.reason, conversationId)
        );
      }

      await sendIntercomReply(conversationId, data.frtAcknowledgement);

      return res.status(200).json(
        renderAckSentPanel(data, conversationId)
      );
    }

    return res.status(200).json(
      renderMainPanel(data)
    );
  } catch (error) {
    console.error("AgentVue error:", error.message);

    return res.status(200).json(
      buildCanvas([
        {
          type: "text",
          text: "AgentVue",
          style: "header"
        },
        {
          type: "text",
          text: "🔴 Something went wrong."
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
          text: "Check permissions, INTERCOM_ACCESS_TOKEN, and JAMES_ADMIN_ID."
        }
      ])
    );
  }
}

app.post("/intercom/initialize", renderAgentVue);
app.post("/intercom/submit", renderAgentVue);

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`AgentVue running on port ${port}`);
});

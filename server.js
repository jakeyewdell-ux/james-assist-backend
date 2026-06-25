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
 * Shift tracking:
 * - Counts all cases closed by James between 00:00–08:00 ICT
 * - Breaks are NOT excluded from the closed case count
 * - Counts close events, not updated_at only
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

const ICT_OFFSET_SECONDS = 7 * 60 * 60;

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

function formatCasesPerHour(value) {
  if (!Number.isFinite(value)) return "0.0/hr";
  return `${value.toFixed(1)}/hr`;
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

function truncateText(text, maxLength = 120) {
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

  if (sourceItem?.created_at) items.push(sourceItem);

  for (const part of parts) {
    if (part.created_at) items.push(part);
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
    lower.includes("payout") ||
    lower.includes("withdraw") ||
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
    lower.includes("impersonating") ||
    lower.includes("hacked")
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
  if (frt.risk === "High") return "Reply immediately to protect FRT.";
  if (firstClose.risk === "High") return "Prioritise resolution or close if solved.";

  if (topic === "Payments / payouts") return "Check payout/payment status.";
  if (topic === "Verification") return "Check verification status and document guidance.";
  if (topic === "Billing / subscription") return "Check billing/subscription context.";
  if (topic === "Account access") return "Check account status and access history.";
  if (topic === "Content / uploads") return "Check content/upload context.";

  return "Review and use the relevant support process.";
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

function buildFTRAcknowledgement(topic, frt) {
  if (frt.risk === "High") {
    return "Hey there, thanks so much for waiting. I’m really sorry for the delay here — I’m checking this for you now and will help as quickly as possible. 💚";
  }

  if (frt.risk === "Medium") {
    return "Hey there, thanks so much for reaching out! I’m taking a look into this for you now and will help get this checked as quickly as possible. 💚";
  }

  if (topic === "Payments / payouts") {
    return "Hey there, thanks so much for reaching out! I’m checking the payout/payment details for you now and will help get this looked into as quickly as possible. 💚";
  }

  if (topic === "Verification") {
    return "Hey there, thanks so much for reaching out! I’m checking the verification details for you now and will help confirm the next steps. 💚";
  }

  if (topic === "Billing / subscription") {
    return "Hey there, thanks so much for reaching out! I’m checking the billing/subscription details for you now and will help get this looked into. 💚";
  }

  if (topic === "Account access") {
    return "Hey there, thanks so much for reaching out! I’m checking the account access details for you now and will help with the next steps. 💚";
  }

  if (topic === "Content / uploads") {
    return "Hey there, thanks so much for reaching out! I’m checking the content/upload details for you now and will help get this looked into. 💚";
  }

  return "Hey there, thanks so much for reaching out! I’m checking this for you now and will help get this sorted. 💚";
}

function buildAdminNote(topic, latestCustomerMessage) {
  const today = new Date().toISOString().slice(0, 10);
  return `${today} JY: Customer contacted support. Topic: ${topic}. Preview: ${latestCustomerMessage}`;
}

function getPriority(frt, firstClose, currentWait, conversation, shift) {
  if (frt.risk === "High" || firstClose.risk === "High") {
    return {
      label: "🔴 High",
      summary: "Action needed now"
    };
  }

  if (shift && shift.available && shift.paceStatus === "Behind") {
    return {
      label: "🔴 High",
      summary: "Case pace behind"
    };
  }

  if (frt.risk === "Medium" || firstClose.risk === "Medium") {
    return {
      label: "🟡 Medium",
      summary: "Needs attention soon"
    };
  }

  if (shift && shift.available && shift.paceStatus === "Slightly behind") {
    return {
      label: "🟡 Medium",
      summary: "Case pace slightly behind"
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

function getRecommendedAction(conversation, frt, firstClose, currentWait, shift) {
  const isClosed = conversation.state === "closed";
  const isOpen = conversation.open === true;

  if (frt.risk === "High") return "Reply now to protect FRT.";
  if (frt.risk === "Medium") return "Reply soon — FRT is near 15 min.";
  if (firstClose.risk === "High") return "Prioritise resolution or close if solved.";
  if (firstClose.risk === "Medium") return "Move toward resolution.";

  if (shift && shift.available && shift.paceStatus === "Behind") {
    return `Push close-ready cases — ${shift.remainingForMinTarget} more needed for 30.`;
  }

  if (shift && shift.available && shift.paceStatus === "Slightly behind") {
    return "Slightly behind case pace — prioritise close-ready conversations.";
  }

  if (isClosed) return "No action — conversation is closed.";

  if (isOpen && frt.done && currentWait.seconds !== null && currentWait.seconds >= 10 * 60) {
    return "Customer replied — review and respond if needed.";
  }

  if (isOpen && frt.done) return "First reply complete. Close when solved.";

  return "Healthy for now.";
}

function getMetricScore(frt, firstClose, shift) {
  let score = 100;

  if (frt.risk === "High") score -= 40;
  if (frt.risk === "Medium") score -= 20;
  if (frt.risk === "Missed") score -= 30;

  if (firstClose.risk === "High") score -= 35;
  if (firstClose.risk === "Medium") score -= 15;
  if (firstClose.risk === "Missed") score -= 25;

  if (shift && shift.available) {
    if (shift.paceStatus === "Behind") score -= 25;
    if (shift.paceStatus === "Slightly behind") score -= 12;
  }

  if (score < 0) score = 0;

  if (score >= 85) return `🟢 ${score}/100`;
  if (score >= 60) return `🟡 ${score}/100`;
  return `🔴 ${score}/100`;
}

function ictLocalToUnixTimestamp(year, monthIndex, day, hour, minute = 0) {
  return Math.floor(
    (Date.UTC(year, monthIndex, day, hour, minute, 0) -
      ICT_OFFSET_SECONDS * 1000) / 1000
  );
}

function getShiftWindowICT() {
  const nowMs = Date.now();
  const ictNow = new Date(nowMs + ICT_OFFSET_SECONDS * 1000);

  const year = ictNow.getUTCFullYear();
  const monthIndex = ictNow.getUTCMonth();
  const day = ictNow.getUTCDate();

  const shiftStart = ictLocalToUnixTimestamp(
    year,
    monthIndex,
    day,
    TARGETS.shiftStartHourICT
  );

  const shiftEnd = ictLocalToUnixTimestamp(
    year,
    monthIndex,
    day,
    TARGETS.shiftEndHourICT
  );

  return {
    now: Math.floor(nowMs / 1000),
    shiftStart,
    shiftEnd,
    label: `${String(TARGETS.shiftStartHourICT).padStart(2, "0")}:00–${String(TARGETS.shiftEndHourICT).padStart(2, "0")}:00 ICT`
  };
}

function calculateShiftElapsed(window) {
  const nowClamped = Math.min(Math.max(window.now, window.shiftStart), window.shiftEnd);

  const totalShiftSeconds = window.shiftEnd - window.shiftStart;
  const elapsedSeconds = Math.max(0, nowClamped - window.shiftStart);
  const remainingSeconds = Math.max(0, totalShiftSeconds - elapsedSeconds);

  const progress =
    totalShiftSeconds > 0
      ? Math.min(1, Math.max(0, elapsedSeconds / totalShiftSeconds))
      : 0;

  let shiftStatus = "In shift";

  if (window.now < window.shiftStart) shiftStatus = "Before shift";
  if (window.now >= window.shiftEnd) shiftStatus = "Shift ended";

  return {
    shiftStatus,
    totalShiftSeconds,
    elapsedSeconds,
    remainingSeconds,
    progress,
    elapsedText: formatDuration(elapsedSeconds),
    totalText: formatDuration(totalShiftSeconds),
    remainingText: formatDuration(remainingSeconds)
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

async function searchCandidateConversationsForShift(shiftStart, shiftEnd) {
  const token = process.env.INTERCOM_ACCESS_TOKEN;

  if (!token) {
    throw new Error("Missing INTERCOM_ACCESS_TOKEN environment variable");
  }

  const all = [];
  let startingAfter = null;

  for (let page = 0; page < 5; page += 1) {
    const pagination = {
      per_page: 100
    };

    if (startingAfter) {
      pagination.starting_after = startingAfter;
    }

    const response = await fetch("https://api.intercom.io/conversations/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "Intercom-Version": "2.11"
      },
      body: JSON.stringify({
        query: {
          operator: "AND",
          value: [
            {
              field: "updated_at",
              operator: ">",
              value: shiftStart - 2 * 60 * 60
            },
            {
              field: "updated_at",
              operator: "<",
              value: shiftEnd + 2 * 60 * 60
            }
          ]
        },
        pagination
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Intercom shift search error ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const conversations = data.conversations || [];

    all.push(...conversations);

    const nextPage = data.pages?.next;
    const nextStartingAfter = nextPage?.starting_after;

    if (!nextStartingAfter) break;

    startingAfter = nextStartingAfter;
  }

  return all;
}

function isJamesAdmin(author) {
  const jamesAdminId = String(process.env.JAMES_ADMIN_ID || "");

  if (!jamesAdminId || !author) return false;

  return String(author.id || "") === jamesAdminId;
}

function getJamesCloseEvents(conversation) {
  const parts = getAllConversationParts(conversation);

  return parts.filter((part) => {
    const type = String(part.part_type || part.type || "").toLowerCase();

    const looksLikeClose =
      type.includes("close") ||
      type === "conversation_closed" ||
      type === "closed";

    return (
      looksLikeClose &&
      part.created_at &&
      isJamesAdmin(part.author)
    );
  });
}

function getFallbackCloseTimeIfLikelyJames(conversation) {
  const jamesAdminId = String(process.env.JAMES_ADMIN_ID || "");
  const assignedAdminId = String(conversation.admin_assignee_id || "");

  if (!jamesAdminId || assignedAdminId !== jamesAdminId) {
    return null;
  }

  return (
    conversation.statistics?.last_close_at ||
    conversation.statistics?.first_close_at ||
    conversation.closed_at ||
    null
  );
}

async function countJamesClosedCasesThisShift(shiftStart, shiftEnd) {
  const candidates = await searchCandidateConversationsForShift(shiftStart, shiftEnd);
  const countedConversationIds = new Set();

  for (const item of candidates) {
    const conversationId = item.id;

    if (!conversationId) continue;

    let fullConversation;

    try {
      fullConversation = await fetchIntercomConversation(conversationId);
    } catch (error) {
      console.error(`Could not fetch conversation ${conversationId}:`, error.message);
      continue;
    }

    const closeEvents = getJamesCloseEvents(fullConversation);

    const jamesClosedInsideShift = closeEvents.some((event) => {
      return event.created_at >= shiftStart && event.created_at < shiftEnd;
    });

    if (jamesClosedInsideShift) {
      countedConversationIds.add(conversationId);
      continue;
    }

    const fallbackCloseTime = getFallbackCloseTimeIfLikelyJames(fullConversation);

    if (
      fallbackCloseTime &&
      fallbackCloseTime >= shiftStart &&
      fallbackCloseTime < shiftEnd
    ) {
      countedConversationIds.add(conversationId);
    }
  }

  return {
    count: countedConversationIds.size,
    ids: Array.from(countedConversationIds)
  };
}

async function calculateShiftCases() {
  try {
    const window = getShiftWindowICT();
    const elapsed = calculateShiftElapsed(window);

    const result = await countJamesClosedCasesThisShift(
      window.shiftStart,
      Math.min(window.now, window.shiftEnd)
    );

    const closedCount = result.count;

    const expectedMinByNow = Math.floor(TARGETS.dailyCasesMin * elapsed.progress);
    const expectedMaxByNow = Math.ceil(TARGETS.dailyCasesMax * elapsed.progress);

    const remainingForMinTarget = Math.max(0, TARGETS.dailyCasesMin - closedCount);
    const remainingForMaxTarget = Math.max(0, TARGETS.dailyCasesMax - closedCount);

    const remainingHours = elapsed.remainingSeconds / 3600;

    const requiredPaceMin =
      remainingHours > 0 ? remainingForMinTarget / remainingHours : remainingForMinTarget;

    const requiredPaceMax =
      remainingHours > 0 ? remainingForMaxTarget / remainingHours : remainingForMaxTarget;

    let paceStatus = "On track";
    let paceIcon = "🟢";

    if (closedCount < Math.floor(expectedMinByNow * 0.8)) {
      paceStatus = "Behind";
      paceIcon = "🔴";
    } else if (closedCount < expectedMinByNow) {
      paceStatus = "Slightly behind";
      paceIcon = "🟡";
    }

    if (closedCount >= expectedMinByNow) {
      paceStatus = "On track";
      paceIcon = "🟢";
    }

    if (closedCount >= TARGETS.dailyCasesMin) {
      paceStatus = "Minimum hit";
      paceIcon = "✅";
    }

    if (closedCount >= TARGETS.dailyCasesMax) {
      paceStatus = "Strong target hit";
      paceIcon = "🏆";
    }

    return {
      available: true,
      count: closedCount,
      countedIds: result.ids,
      shiftStatus: elapsed.shiftStatus,
      shiftLabel: window.label,
      elapsedText: elapsed.elapsedText,
      totalText: elapsed.totalText,
      remainingText: elapsed.remainingText,
      progressPercent: Math.round(elapsed.progress * 100),
      expectedMinByNow,
      expectedMaxByNow,
      remainingForMinTarget,
      remainingForMaxTarget,
      requiredPaceMin,
      requiredPaceMax,
      paceStatus,
      paceIcon
    };
  } catch (error) {
    console.error("Shift case monitor error:", error.message);

    return {
      available: false,
      error: error.message.substring(0, 250)
    };
  }
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
  const shift = await calculateShiftCases();

  const latestCustomerMessage = getLatestCustomerMessage(conversation);
  const detectedTopic = detectTopic(latestCustomerMessage);
  const topicSuggestion = getTopicSuggestion(detectedTopic, frt, firstClose);

  const priority = getPriority(frt, firstClose, currentWait, conversation, shift);
  const recommendedAction = getRecommendedAction(
    conversation,
    frt,
    firstClose,
    currentWait,
    shift
  );

  const suggestedReply = buildSuggestedReply(
    detectedTopic,
    latestCustomerMessage,
    frt
  );

  const frtAcknowledgement = buildFTRAcknowledgement(
    detectedTopic,
    frt,
    currentWait
  );

  const adminNote = buildAdminNote(detectedTopic, latestCustomerMessage);

  const state = conversation.state || "Unknown";
  const open = conversation.open === true ? "Open" : "Not open";
  const metricScore = getMetricScore(frt, firstClose, shift);

  return {
    conversation,
    frt,
    firstClose,
    currentWait,
    shift,
    latestCustomerMessage,
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

function renderShiftSummary(shift) {
  if (!shift || !shift.available) {
    return [
      {
        type: "text",
        text: `📊 Shift: unavailable — ${shift?.error || "Unknown error"}`
      }
    ];
  }

  return [
    {
      type: "text",
      text: `📊 Cases: ${shift.paceIcon} ${shift.count}/${TARGETS.dailyCasesMin} · ${shift.paceStatus}`
    },
    {
      type: "text",
      text: `Expected: ${shift.expectedMinByNow}–${shift.expectedMaxByNow} · Left: ${shift.remainingForMinTarget} · Pace: ${formatCasesPerHour(shift.requiredPaceMin)}`
    }
  ];
}

function renderMainPanel(data, teammateName, conversationId) {
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

    ...renderShiftSummary(data.shift),

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
      text: `🧭 ${data.detectedTopic} · ${data.topicSuggestion}`
    },
    {
      type: "text",
      text: `💬 ${data.suggestedReply}`
    },
    {
      type: "text",
      text: `📝 ${data.adminNote}`
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
    },

    {
      type: "text",
      text: `${data.state}/${data.open} · ${teammateName}`
    },
    {
      type: "text",
      text: `Targets: 30–50 cases · FRT <15m · Close <1h20m · CSAT 65%`
    }
  ]);
}

function renderAckSentPanel(data, teammateName, conversationId) {
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
      text: `Sent as James admin ID: ${process.env.JAMES_ADMIN_ID}`
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
  const teammateName = getTeammateNameFromBody(body);
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

    if (componentId === "send_frt_ack") {
      const safety = canSendFTRAck(data.conversation, data);

      if (!safety.allowed) {
        return res.status(200).json(
          renderAckBlockedPanel(safety.reason, conversationId)
        );
      }

      await sendIntercomReply(conversationId, data.frtAcknowledgement);

      return res.status(200).json(
        renderAckSentPanel(data, teammateName, conversationId)
      );
    }

    return res.status(200).json(
      renderMainPanel(data, teammateName, conversationId)
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

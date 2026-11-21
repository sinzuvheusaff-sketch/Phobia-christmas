"use strict";
const MAX_PROCESSED_MESSAGE_IDS = 5000;
const processedMessageIDs = new Map();

function isDuplicateMessage(messageID) {
  if (messageID === undefined || messageID === null || String(messageID).trim() === "") return false;
  const id = String(messageID);
  if (processedMessageIDs.has(id)) return true;
  processedMessageIDs.set(id, Date.now());
  while (processedMessageIDs.size > MAX_PROCESSED_MESSAGE_IDS) {
    processedMessageIDs.delete(processedMessageIDs.keys().next().value);
  }
  return false;
}
function resetProcessedMessages() { processedMessageIDs.clear(); }
module.exports = { isDuplicateMessage, resetProcessedMessages, MAX_PROCESSED_MESSAGE_IDS };

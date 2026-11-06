// In-memory upload bookkeeping (single-instance by design, like the rest of the app's state).
//
// Everything is keyed by `${userId}:${uploadId}` so one user can never read or cancel
// another user's upload by guessing or learning its id.
const UPLOAD_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;
const MAX_CONCURRENT_UPLOADS = 2;

const progress = new Map();
const cancelled = new Map();
let active = 0;

const key = (userId, uploadId) => `${userId}:${uploadId}`;
const isValidUploadId = (id) => typeof id === 'string' && UPLOAD_ID_PATTERN.test(id);

// Concurrency gate for the (memory- and CPU-hungry) upload route.
function tryStartUpload() {
    if (active >= MAX_CONCURRENT_UPLOADS) return false;
    active++;
    return true;
}
function finishUpload() {
    active = Math.max(0, active - 1);
}

module.exports = {
    progress,
    cancelled,
    key,
    isValidUploadId,
    tryStartUpload,
    finishUpload,
    MAX_CONCURRENT_UPLOADS,
    getActiveUploads: () => active,
};

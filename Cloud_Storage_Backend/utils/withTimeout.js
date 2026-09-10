// A wedged MTProto connection can leave a call pending forever with no error — timing
// it out turns that into a normal failure so callers (a per-user download queue, a
// health check) aren't stuck waiting on something that will never resolve.
function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

module.exports = { withTimeout };

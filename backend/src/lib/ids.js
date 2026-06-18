'use strict';

const crypto = require('crypto');

// [Review #7] Generate identifiers with a cryptographically strong random component.
// The previous `Date.now() + Math.random()` scheme produced partially predictable
// ids; since any authenticated user can open a trip by id when sharing is enabled,
// predictable trip ids weakened that link-share boundary. crypto.randomUUID() removes
// the predictability while keeping ids URL-safe and collision-free.
function uuid() {
  return crypto.randomUUID();
}

module.exports = { uuid };

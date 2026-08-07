// Returns the current date/time as if it were UK local time, accounting for BST/GMT.
// BST runs late March to late October (approximately) — this uses the same
// simple month-based heuristic already used elsewhere in the project.
function getUKNow() {
  const now = new Date();
  const isBST = now.getUTCMonth() > 2 && now.getUTCMonth() < 9;
  const offsetHours = isBST ? 1 : 0;
  return new Date(now.getTime() + offsetHours * 60 * 60 * 1000);
}

function getUKDateString(date = getUKNow()) {
  return date.getUTCFullYear() + '-' +
    String(date.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(date.getUTCDate()).padStart(2, '0');
}

module.exports = { getUKNow, getUKDateString };
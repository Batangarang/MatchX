const fs = require('fs');

function parseFixtureDate(dateStr) {
  const match = dateStr.match(/(\d{1,2})\s+(\w+)\s+(\d{4})/);
  if (!match) return null;
  const months = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  const monthIndex = months.indexOf(match[2].toLowerCase());
  if (monthIndex === -1) return null;
  return new Date(parseInt(match[3]), monthIndex, parseInt(match[1]));
}

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function isWeekend(date) {
  const day = date.getDay();
  return day === 0 || day === 6;
}

const MODE = process.env.RECAP_MODE;
const now = new Date();

if (!fs.existsSync('division-fixtures.json')) {
  console.log('run=false');
  process.exit(0);
}

const { fixtures } = JSON.parse(fs.readFileSync('division-fixtures.json', 'utf-8'));
let hasRelevantFixtures = false;

if (MODE === 'midweek-preview') {
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  hasRelevantFixtures = fixtures.some(f => {
    const d = parseFixtureDate(f.date);
    return d && isSameDay(d, tomorrow) && !isWeekend(d);
  });
} else if (MODE === 'midweek-recap') {
  hasRelevantFixtures = fixtures.some(f => {
    const d = parseFixtureDate(f.date);
    return d && isSameDay(d, now) && !isWeekend(d);
  });
} else if (MODE === 'weekend-recap') {
  hasRelevantFixtures = fixtures.some(f => {
    const d = parseFixtureDate(f.date);
    return d && isWeekend(d) && Math.abs(d - now) < 3 * 24 * 60 * 60 * 1000;
  });
} else {
  hasRelevantFixtures = true; // weekend-preview always allowed to check
}

console.log(hasRelevantFixtures ? 'run=true' : 'run=false');
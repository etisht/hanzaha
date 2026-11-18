// קובע סיסמא חדשה למשתמש קיים ישירות ב-DB (לשחזור גישה כשאין אדמין שיכול להתחבר).
// הרצה מתיקיית הפרויקט:  node functions/set-password.js <username>
// דורש התחברות ל-Firebase CLI (npx firebase-tools@13 login) עם הרשאות לפרויקט.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { execFileSync } = require('child_process');

const PROJECT = 'hanzaha-d558c';
const username = process.argv[2];
if (!username) { console.error('שימוש: node functions/set-password.js <username>'); process.exit(1); }

function cli(args) {
  return execFileSync('npx', ['-y', 'firebase-tools@13', '--project', PROJECT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer); }));
}

(async () => {
  const users = JSON.parse(cli(['database:get', '/users']) || '{}') || {};
  const ids = Object.keys(users).filter(id => users[id].username === username || users[id].email === username);
  if (ids.length !== 1) { console.error(ids.length ? 'נמצא יותר ממשתמש אחד בשם הזה' : 'המשתמש לא נמצא'); process.exit(1); }

  const password = await ask(`סיסמא חדשה עבור ${username}: `);
  if (password.length < 6) { console.error('הסיסמא קצרה מדי (מינימום 6 תווים)'); process.exit(1); }

  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'setpw-')), 'update.json');
  fs.writeFileSync(tmp, JSON.stringify({ [`userSecrets/${ids[0]}`]: { salt, hash }, loginAttempts: null }), { mode: 0o600 });
  try {
    cli(['database:update', '/', tmp, '--force']);
  } finally {
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  }
  console.log('✔ הסיסמא עודכנה. אפשר להתחבר לאתר.');
})();

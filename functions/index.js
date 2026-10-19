// ============================================================
//  Cloud Functions — התחברות וניהול משתמשים
//  סיסמאות נשמרות רק כ-hash ב-userSecrets/{uid}, נתיב שחסום לכל לקוח בכללי ה-DB.
//  ה-uid ב-Firebase Auth זהה למפתח המשתמש ב-users/{uid}, כך שהפניות קיימות (capturedBy וכו') נשמרות.
// ============================================================
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onValueWritten } = require('firebase-functions/v2/database');
const { setGlobalOptions } = require('firebase-functions/v2');
const { initializeApp } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const { getAuth } = require('firebase-admin/auth');
const crypto = require('crypto');

initializeApp();
setGlobalOptions({ region: 'europe-west1', maxInstances: 10 });
const db = getDatabase();

const ROLES = ['admin', 'senior', 'user', 'viewer', 'basic'];
const MAX_FAILED_LOGINS = 10;
const LOCKOUT_MS = 15 * 60 * 1000;

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}

function verifyPassword(password, secret) {
  if (!secret || !secret.salt || !secret.hash) return false;
  const { hash } = hashPassword(password, secret.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(secret.hash, 'hex'));
}

// מעביר סיסמאות טקסט-גלוי ישנות (users/{id}/password) ל-hash ב-userSecrets. רץ פעם אחת בלבד.
async function ensurePasswordsMigrated() {
  if ((await db.ref('meta/passwordsMigrated').once('value')).val() === true) return;
  const snap = await db.ref('users').once('value');
  const updates = {};
  snap.forEach(child => {
    const pw = child.val().password;
    if (pw != null && pw !== '') {
      updates[`userSecrets/${child.key}`] = hashPassword(String(pw));
      updates[`users/${child.key}/password`] = null;
    }
  });
  updates['meta/passwordsMigrated'] = true;
  await db.ref().update(updates);
}

// התאמה ללא תלות באותיות גדולות/קטנות ורווחים (טלפונים מגדילים אוטומטית את האות הראשונה)
async function findUserIds(login) {
  const norm = v => String(v || '').trim().toLowerCase();
  const target = norm(login);
  const snap = await db.ref('users').once('value');
  const ids = [];
  snap.forEach(child => {
    const u = child.val();
    if (norm(u.username) === target || (u.email && norm(u.email) === target)) ids.push(child.key);
  });
  return ids;
}

function attemptsRef(login) {
  return db.ref(`loginAttempts/${crypto.createHash('sha256').update(login.toLowerCase()).digest('hex')}`);
}

exports.login = onCall(async (req) => {
  const login = String(req.data?.username || '').trim();
  const password = String(req.data?.password || '');
  if (!login || !password) throw new HttpsError('invalid-argument', 'נא למלא שם משתמש וסיסמא');

  const attempts = attemptsRef(login);
  const prev = (await attempts.once('value')).val();
  if (prev && prev.count >= MAX_FAILED_LOGINS && Date.now() - prev.since < LOCKOUT_MS) {
    throw new HttpsError('resource-exhausted', 'יותר מדי ניסיונות כושלים — נסה שוב בעוד 15 דקות');
  }

  await ensurePasswordsMigrated();

  for (const id of await findUserIds(login)) {
    const secret = (await db.ref(`userSecrets/${id}`).once('value')).val();
    if (verifyPassword(password, secret)) {
      await attempts.remove();
      return { token: await getAuth().createCustomToken(id) };
    }
  }

  const fresh = !prev || Date.now() - prev.since >= LOCKOUT_MS;
  await attempts.set({ count: fresh ? 1 : prev.count + 1, since: fresh ? Date.now() : prev.since });
  throw new HttpsError('unauthenticated', 'שם משתמש / אימייל או סיסמא שגויים');
});

async function requireAdmin(req) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'נדרשת התחברות');
  const role = (await db.ref(`users/${req.auth.uid}/role`).once('value')).val();
  if (role !== 'admin') throw new HttpsError('permission-denied', 'פעולה זו מותרת לאדמין בלבד');
}

exports.saveUser = onCall(async (req) => {
  await requireAdmin(req);
  const id = req.data?.id ? String(req.data.id) : null;
  const displayName = String(req.data?.displayName || '').trim();
  const username = String(req.data?.username || '').trim();
  const role = String(req.data?.role || '');
  const password = req.data?.password ? String(req.data.password) : '';

  if (!displayName || !username) throw new HttpsError('invalid-argument', 'נא למלא שם ושם משתמש');
  if (!ROLES.includes(role)) throw new HttpsError('invalid-argument', 'תפקיד לא חוקי');
  if (!id && !password) throw new HttpsError('invalid-argument', 'נא להזין סיסמא');
  if (id === req.auth.uid && role !== 'admin') throw new HttpsError('failed-precondition', 'לא ניתן להוריד לעצמך הרשאת אדמין');
  if (id && !(await db.ref(`users/${id}`).once('value')).exists()) throw new HttpsError('not-found', 'המשתמש לא נמצא');

  if ((await findUserIds(username)).some(other => other !== id)) throw new HttpsError('already-exists', 'שם המשתמש כבר קיים');

  const userId = id || db.ref('users').push().key;
  const updates = {
    [`users/${userId}/displayName`]: displayName,
    [`users/${userId}/username`]: username,
    [`users/${userId}/role`]: role,
  };
  if (password) updates[`userSecrets/${userId}`] = hashPassword(password);
  await db.ref().update(updates);

  // סיסמא שהוחלפה מנתקת חיבורים קיימים של המשתמש במכשירים אחרים
  if (id && password) {
    await getAuth().revokeRefreshTokens(userId).catch(e => { if (e.code !== 'auth/user-not-found') throw e; });
  }
  return { id: userId };
});

exports.deleteUser = onCall(async (req) => {
  await requireAdmin(req);
  const id = String(req.data?.id || '');
  if (!id) throw new HttpsError('invalid-argument', 'חסר מזהה משתמש');
  if (id === req.auth.uid) throw new HttpsError('failed-precondition', 'לא ניתן למחוק את עצמך');
  await db.ref().update({ [`users/${id}`]: null, [`userSecrets/${id}`]: null });
  await getAuth().deleteUser(id).catch(e => { if (e.code !== 'auth/user-not-found') throw e; });
  return { ok: true };
});

// ============================================================
//  commemorationsPublic — עותק מצומצם להרשאת צפייה בסיסית (basic)
//  בלי פרטי תופס / תורם / מוכר, וסטאטוס רק פנויה / לא פנויה.
//  basic חסום מקריאת commemorations בכללי ה-DB וקורא רק מכאן.
// ============================================================
const DB_INSTANCE = 'hanzaha-d558c-default-rtdb';
const PUBLIC_FIELDS = ['projectId', 'typeId', 'name', 'price', 'notes', 'isDisabled', 'isWholeProject', 'isFreeItem', 'parentGroupId', 'unitIndex', 'totalUnits'];

// soldReport — עמודות "דוח הנצחות שנמכרו" בלבד, כדי ש-basic יוכל לצפות בדוח
const SOLD_REPORT_FIELDS = ['projectId', 'typeId', 'name', 'price', 'isWholeProject', 'soldAt', 'donorName', 'donorPhone', 'donorNumber', 'donationNumber', 'captureFundraiserName', 'donationSource'];

function toSoldReport(c) {
  if (!c || c.status !== 'sold') return null;
  const out = { status: 'sold' };
  for (const f of SOLD_REPORT_FIELDS) if (c[f] !== undefined) out[f] = c[f];
  return out;
}

function toPublic(c) {
  const out = { status: c.status === 'available' ? 'available' : 'taken' };
  for (const f of PUBLIC_FIELDS) if (c[f] !== undefined) out[f] = c[f];
  return out;
}

exports.syncPublicComm = onValueWritten({ ref: '/commemorations/{commId}', instance: DB_INSTANCE }, async (event) => {
  const after = event.data.after.val();
  await db.ref(`commemorationsPublic/${event.params.commId}`).set(after ? toPublic(after) : null);
  await db.ref(`soldReport/${event.params.commId}`).set(toSoldReport(after));
});

// בנייה מלאה של commemorationsPublic (לנתונים שקדמו לטריגר). נקרא אוטומטית מאדמין פעם אחת.
exports.rebuildPublicComms = onCall(async (req) => {
  await requireAdmin(req);
  const snap = await db.ref('commemorations').once('value');
  const pub = {};
  const sold = {};
  snap.forEach(child => {
    pub[child.key] = toPublic(child.val());
    const s = toSoldReport(child.val());
    if (s) sold[child.key] = s;
  });
  await db.ref('commemorationsPublic').set(pub);
  await db.ref('soldReport').set(sold);
  await db.ref('meta/publicCommsSynced').set(true);
  await db.ref('meta/soldReportSynced').set(true);
  return { count: Object.keys(pub).length };
});

// ============================================================
//  Webhooks יוצאים — הודעה למערכת חיצונית על פתיחה ושינוי סטאטוס של פרויקטים והנצחות.
//  נשלחים רק שדות מרשימה מותרת (בלי פרטי תורם / תופס / מוכר). תיעוד הפורמט: WEBHOOKS.md
//  הגדרה: WEBHOOK_URL בקובץ functions/.env, והסוד לחתימה: firebase functions:secrets:set WEBHOOK_SECRET
// ============================================================
const { defineString, defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions');

const WEBHOOK_URL = defineString('WEBHOOK_URL', { default: '' });
const WEBHOOK_SECRET = defineSecret('WEBHOOK_SECRET');

const WEBHOOK_PROJECT_FIELDS = ['name', 'description', 'region', 'population', 'sector', 'location', 'notes', 'priority', 'stage', 'expectedCompletion', 'createdAt', 'typePrices'];
const WEBHOOK_COMM_FIELDS = ['projectId', 'typeId', 'name', 'price', 'notes', 'isDisabled', 'isWholeProject', 'isFreeItem', 'parentGroupId', 'unitIndex', 'totalUnits', 'capturedAt', 'captureExpiry', 'soldAt'];

function pick(obj, fields) {
  const out = {};
  for (const f of fields) if (obj[f] !== undefined && obj[f] !== null) out[f] = obj[f];
  return out;
}

// אותה לוגיקה כמו getProjectStatus בצד הלקוח
const projectStatusOf = p => p.projectStatus || (p.isActive ? 'active' : 'closed');

async function sendWebhook(eventId, type, data) {
  const url = WEBHOOK_URL.value();
  if (!url) return;
  const body = JSON.stringify({ id: eventId, type, occurredAt: new Date().toISOString(), data });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto.createHmac('sha256', WEBHOOK_SECRET.value()).update(`${timestamp}.${body}`).digest('hex');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Webhook-Id': eventId, 'X-Webhook-Timestamp': timestamp, 'X-Webhook-Signature': `sha256=${signature}` },
    body,
    signal: AbortSignal.timeout(10000),
  });
  // 5xx / 429 — זריקת שגיאה גורמת ל-Firebase לנסות שוב. 4xx אחר — שגיאה קבועה, לא מנסים שוב.
  if (res.status >= 500 || res.status === 429) throw new Error(`webhook ${type} failed: HTTP ${res.status}`);
  if (!res.ok) logger.error(`webhook ${type} rejected: HTTP ${res.status}`, { eventId, response: await res.text().catch(() => '') });
}

const WEBHOOK_TRIGGER_OPTS = { instance: DB_INSTANCE, retry: true, secrets: [WEBHOOK_SECRET] };

exports.projectWebhook = onValueWritten({ ref: '/projects/{projectId}', ...WEBHOOK_TRIGGER_OPTS }, async (event) => {
  const before = event.data.before.val();
  const after = event.data.after.val();
  if (!after) return;
  const project = { id: event.params.projectId, status: projectStatusOf(after), ...pick(after, WEBHOOK_PROJECT_FIELDS) };

  if (!before) return sendWebhook(event.id, 'project.created', { project });
  if (projectStatusOf(before) !== project.status) {
    await sendWebhook(`${event.id}-status`, 'project.status_changed', { project, previousStatus: projectStatusOf(before) });
  }
  if ((before.stage || null) !== (after.stage || null)) {
    await sendWebhook(`${event.id}-stage`, 'project.stage_changed', { project, previousStage: before.stage || null });
  }
});

exports.commemorationWebhook = onValueWritten({ ref: '/commemorations/{commId}', ...WEBHOOK_TRIGGER_OPTS }, async (event) => {
  const before = event.data.before.val();
  const after = event.data.after.val();
  if (!after) return;
  const isCreate = !before;
  if (!isCreate && before.status === after.status) return;

  const [projectName, typeName] = await Promise.all([
    after.projectId ? db.ref(`projects/${after.projectId}/name`).once('value').then(s => s.val()) : null,
    after.typeId ? db.ref(`commemorationTypes/${after.typeId}/name`).once('value').then(s => s.val()) : null,
  ]);
  const commemoration = { id: event.params.commId, status: after.status, ...pick(after, WEBHOOK_COMM_FIELDS), projectName, typeName };

  if (isCreate) return sendWebhook(event.id, 'commemoration.created', { commemoration });
  return sendWebhook(event.id, 'commemoration.status_changed', { commemoration, previousStatus: before.status });
});

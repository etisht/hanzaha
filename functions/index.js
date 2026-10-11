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

async function findUserIds(login) {
  const ids = new Set();
  for (const field of ['username', 'email']) {
    const snap = await db.ref('users').orderByChild(field).equalTo(login).once('value');
    snap.forEach(child => { ids.add(child.key); });
  }
  return [...ids];
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

  const dup = await db.ref('users').orderByChild('username').equalTo(username).once('value');
  let taken = false;
  dup.forEach(child => { if (child.key !== id) taken = true; });
  if (taken) throw new HttpsError('already-exists', 'שם המשתמש כבר קיים');

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

function toPublic(c) {
  const out = { status: c.status === 'available' ? 'available' : 'taken' };
  for (const f of PUBLIC_FIELDS) if (c[f] !== undefined) out[f] = c[f];
  return out;
}

exports.syncPublicComm = onValueWritten({ ref: '/commemorations/{commId}', instance: DB_INSTANCE }, async (event) => {
  const after = event.data.after.val();
  await db.ref(`commemorationsPublic/${event.params.commId}`).set(after ? toPublic(after) : null);
});

// בנייה מלאה של commemorationsPublic (לנתונים שקדמו לטריגר). נקרא אוטומטית מאדמין פעם אחת.
exports.rebuildPublicComms = onCall(async (req) => {
  await requireAdmin(req);
  const snap = await db.ref('commemorations').once('value');
  const pub = {};
  snap.forEach(child => { pub[child.key] = toPublic(child.val()); });
  await db.ref('commemorationsPublic').set(pub);
  await db.ref('meta/publicCommsSynced').set(true);
  return { count: Object.keys(pub).length };
});

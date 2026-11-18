# Webhooks — מערכת ניהול הנצחות

המערכת שולחת `POST` עם גוף JSON לכתובת אחת שהוגדרה מראש, בכל אחד מהאירועים הבאים:

| `type` | מתי |
|---|---|
| `project.created` | נפתח פרויקט חדש |
| `project.status_changed` | השתנה סטאטוס הפרויקט |
| `project.stage_changed` | השתנה שלב הפרויקט |
| `project.visibility_changed` | כל הפרויקט הוסתר מהאתר או הוצג בו שוב |
| `project.crm_id_changed` | השתנה מזהה ה-CRM של הפרויקט במערכת שלנו |
| `project.updated` | השתנה שדה אחר בפרויקט (שם, תיאור, מחירים וכו') |
| `project.deleted` | פרויקט נמחק מהמערכת לצמיתות |
| `commemoration.created` | נוצרה הנצחה חדשה |
| `commemoration.status_changed` | השתנה סטאטוס הנצחה |
| `commemoration.visibility_changed` | הנצחה הוסתרה מהאתר או הוצגה בו שוב |
| `commemoration.updated` | השתנה שדה אחר בהנצחה — למשל סימון "לא למכירה" / החזרה למכירה (`isDisabled`), מחיר, שם |
| `commemoration.deleted` | הנצחה נמחקה מהמערכת לצמיתות |

פרטי תורמים, תופסים ומוכרים **אינם נשלחים**.

## מבנה הבקשה

כותרות:

```
Content-Type: application/json
X-Webhook-Id: <מזהה ייחודי לאירוע>
X-Webhook-Timestamp: <unix seconds>
X-Webhook-Signature: sha256=<hex>
```

גוף:

```json
{
  "id": "…",
  "type": "commemoration.status_changed",
  "occurredAt": "2026-10-12T19:36:31.312Z",
  "data": { … }
}
```

### אירועי פרויקט — `data`

```json
{
  "project": {
    "id": "-Nx…",
    "status": "active",
    "name": "מקווה רמות",
    "description": "…",
    "region": "…",
    "population": 12000,
    "sector": "חרדי",
    "location": "…",
    "notes": "…",
    "priority": 3,
    "stage": "בנייה",
    "expectedCompletion": "2027-03-01",
    "createdAt": 1760000000000,
    "typePrices": { "<typeId>": 5000 },
    "crmId": "CRM-1234",
    "hiddenFromSite": false
  },
  "previousStatus": "active",
  "previousStage": "תכנון",
  "previousCrmId": "CRM-1200",
  "previousHiddenFromSite": false
}
```

`previousStatus` מופיע רק ב-`project.status_changed`, `previousStage` רק ב-`project.stage_changed`, `previousCrmId` רק ב-`project.crm_id_changed` (`null` אם לא היה מזהה קודם), ו-`previousHiddenFromSite` רק ב-`project.visibility_changed`.

`hiddenFromSite` בפרויקט נשלח תמיד (`true` / `false`). כש-`true`, הפרויקט כולו וכל ההנצחות שלו קיימים במערכת אבל לא מוצגים באתר. זו לא מחיקה. כשהפרויקט מוצג שוב יגיע `project.visibility_changed` עם `hiddenFromSite: false`. בזמן ההסתרה ובחזרה ממנה לא נשלחים אירועים נפרדים לכל הנצחה. ההנצחות שומרות על ה-`hiddenFromSite` הפרטי שלהן, ומה שקובע אם הנצחה מוצגת: `!project.hiddenFromSite && !commemoration.hiddenFromSite`.

ב-`project.updated` מגיע גם `changedFields` — רשימת השדות שהשתנו (למשל `["name", "typePrices"]`). שינוי שלב או מזהה CRM לא נכלל בו, כי הם נשלחים באירועים משלהם. אם הפרויקט השתנה שם, יש לעדכן גם את `projectName` בהנצחות שלו באתר.

ב-`project.deleted` נשלחים נתוני הפרויקט כפי שהיו רגע לפני המחיקה. אחרי האירוע הזה הפרויקט כבר לא קיים במערכת, ואין להציג אותו באתר.

ערכי `status` בפרויקט: `active` (פתוח למכירה), `completion` (בהשלמה), `closed` (סגור).

### אירועי הנצחה — `data`

```json
{
  "commemoration": {
    "id": "-Ny…",
    "status": "sold",
    "projectId": "-Nx…",
    "projectName": "מקווה רמות",
    "projectCrmId": "CRM-1234",
    "typeId": "t3",
    "typeName": "חדר כלה",
    "name": "חדר כלה",
    "price": 18000,
    "notes": "…",
    "isDisabled": false,
    "hiddenFromSite": false,
    "projectHiddenFromSite": false,
    "isWholeProject": false,
    "isFreeItem": false,
    "parentGroupId": "…",
    "unitIndex": 1,
    "totalUnits": 4,
    "capturedAt": 1760000000000,
    "captureExpiry": 1760172800000,
    "soldAt": 1760000000000
  },
  "previousStatus": "available",
  "previousHiddenFromSite": false
}
```

`previousStatus` מופיע רק ב-`commemoration.status_changed`, ו-`previousHiddenFromSite` רק ב-`commemoration.visibility_changed`.

ב-`commemoration.updated` מגיע גם `changedFields` — רשימת השדות שהשתנו (למשל `["isDisabled"]`). כש-`isDisabled: true` ההנצחה סגורה למכירה ויש להציג אותה כלא זמינה; `false` — חזרה למכירה. אם באותו עדכון השתנה גם הסטאטוס, יגיעו שני אירועים: `status_changed` ו-`updated`. הדרך הפשוטה לטפל: בכל אירוע לעדכן את כל ההנצחה לפי `commemoration`.

`hiddenFromSite` נשלח תמיד (`true` / `false`). כש-`true` — ההנצחה קיימת במערכת אך אין להציג אותה באתר (למשל יחידות של פריט שפוצל). זו לא מחיקה: אם היא תוצג שוב יגיע `commemoration.visibility_changed` עם `hiddenFromSite: false`.

`projectHiddenFromSite` מציין אם כל הפרויקט של ההנצחה מוסתר מהאתר (ראו `project.visibility_changed`). כש-`true` אין להציג את ההנצחה, גם אם ה-`hiddenFromSite` שלה הוא `false`.

ב-`commemoration.deleted` נשלחים נתוני ההנצחה כפי שהיו רגע לפני המחיקה. ההנצחה כבר לא קיימת במערכת, ויש להסיר אותה מהאתר. מחיקה היא סופית, ולא יגיע עליה אירוע נוסף.

ערכי `status` בהנצחה: `available` (פנויה), `captured` (תפוסה), `sold` (נמכרה).

שדות ריקים אינם נשלחים. כל זמן (`createdAt`, `capturedAt`, `soldAt` וכו') הוא אלפיות שנייה מאז epoch.

## אימות החתימה

החתימה היא HMAC-SHA256 על המחרוזת `<X-Webhook-Timestamp>.<הגוף הגולמי>`, עם הסוד המשותף. כך מאמתים אותה ב-Node.js:

```js
const crypto = require('crypto');

function verify(rawBody, headers, secret) {
  const expected = 'sha256=' + crypto.createHmac('sha256', secret)
    .update(`${headers['x-webhook-timestamp']}.${rawBody}`).digest('hex');
  const fresh = Math.abs(Date.now() / 1000 - Number(headers['x-webhook-timestamp'])) < 300;
  return fresh && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(headers['x-webhook-signature'] || ''));
}
```

חשוב לחשב את החתימה על הגוף **הגולמי**, לפני `JSON.parse`.

## תשובה וניסיונות חוזרים

- `2xx` — האירוע התקבל.
- `5xx` או `429` או timeout (10 שניות) — המערכת תנסה לשלוח שוב.
- כל `4xx` אחר — האירוע נרשם כנדחה ולא נשלח שוב.

אותו אירוע יכול להגיע יותר מפעם אחת. כדי לא לטפל בו פעמיים, בודקים את `X-Webhook-Id`. גם הסדר בין אירועים לא מובטח, אז כדאי להשוות את `occurredAt` לזמן העדכון האחרון שנשמר.

יצירת פרויקט עם הרבה הנצחות שולחת אירוע `commemoration.created` נפרד לכל הנצחה.

## עדכון מזהה CRM מהאתר המחובר

כדי לשמור או לשנות את מזהה ה-CRM של פרויקט אצלנו, שולחים:

```
POST https://europe-west1-hanzaha-d558c.cloudfunctions.net/updateProjectCrmId
Content-Type: application/json
X-Webhook-Timestamp: <unix seconds>
X-Webhook-Signature: sha256=<hex>
```

```json
{ "projectId": "-Nx…", "crmId": "CRM-1234" }
```

- `projectId` — מזהה הפרויקט כפי שמגיע ב-`project.id` באירועים.
- `crmId` — מחרוזת עד 100 תווים. `null` או מחרוזת ריקה מוחקים את המזהה.

החתימה מחושבת באותה שיטה ועם אותו סוד כמו באירועים היוצאים: HMAC-SHA256 על `<X-Webhook-Timestamp>.<הגוף הגולמי>`. חותמת זמן ישנה מ-5 דקות נדחית.

```js
const body = JSON.stringify({ projectId, crmId });
const timestamp = String(Math.floor(Date.now() / 1000));
const signature = 'sha256=' + crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Webhook-Timestamp': timestamp, 'X-Webhook-Signature': signature }, body });
```

תשובות: `200` — נשמר; `400` — גוף לא תקין; `401` — חתימה שגויה או ישנה; `404` — הפרויקט לא נמצא.

עדכון שהגיע בדרך הזו **לא** שולח בחזרה `project.crm_id_changed`. האירוע נשלח רק כשהמזהה שונה במערכת שלנו.

# בקשה ליונתן ולקלוד שלו: כניסה אחת מהאפליקציה של LBV לשמחה, לגאלה ולהרשמה לחגים

שלום יונתן,

אנחנו בונים אפליקציה אחת של LBV (אנדרואיד + האתר lbv-portal-phi.vercel.app/admin). כל מנהל נכנס אליה פעם אחת עם הסיסמה שלו,
ורואה רק את מה שסימנו לו. שמחה, ערבי גאלה וההרשמה לחגים כבר נפתחים בתוך האפליקציה, אבל כל אחד מהם עוד מבקש סיסמה משלו.

הבקשה: להוסיף בכל אחת משלוש המערכות שלך כניסה אחת קטנה שמקבלת "כרטיס כניסה" חתום מהאפליקציה.
אנחנו לא נוגעים בקוד שלך ולא במאגרים שלך. הכול אצלך, אתה מאשר ואתה מפעיל.
הדף "סיסמה" הרגיל נשאר כמו שהוא, כגיבוי.

בהמשך המטרה גם אזור אישי ללקוחות (זוג לחתונה, לקוח של ערב גאלה) באותה אפליקציה. זה שלב הבא, לא עכשיו.

---

## לקלוד של יונתן: מה לבנות (אותו דבר בשלושת המאגרים)

Repos: `Yonathan-Assous/simha-system` (allset.lbv-event.com), `Yonathan-Assous/gala-system` (impact.lbv-event.com),
`Yonathan-Assous/lbv-booking` (booking.lbv-event.com).

### What the LBV app sends
The app sends the browser to `GET https://<system>/api/lbv-sso?t=<JWT>`.

The JWT:
- **Algorithm:** HS256, signed with the shared env var `LBV_SSO_SECRET` (at least 32 random characters, the same value on both sides).
- **Claims:**
  - `iss` = `"lbv-portal"`
  - `aud` = `"simha"` | `"gala"` | `"booking"`. Each system accepts only its own.
  - `sub` = the LBV user id
  - `email` = the person's e-mail, as typed by the LBV owner for that manager
  - `name`
  - `iat`, `exp` = iat + 60 s
  - `jti` = a random UUID

The LBV side already issues this pass (lbv-portal `api/config.js?sso=<system>`). It issues it only to a logged-in user who is allowed that system.

### What the route must do
1. **Verify the token:** with `jose` `jwtVerify(t, secret, { algorithms: ['HS256'], issuer: 'lbv-portal', audience: '<this system>' })`. Reject on any failure, including expiry, with a plain redirect to the normal login page.
2. **Single use:** store `jti` until `exp`, in the DB or in KV, and reject a jti seen before.
3. **Find the account:** look up the existing back-office account by `email`, case-insensitive. Rules:
   - Never create an account from the token.
   - If the account doesn't exist, or is disabled or deleted, send the person to the normal login page.
   - Permissions stay exactly as they are in your system (roles, overrides, which galas or events the account sees).
4. **Open the session:** create your normal session, exactly as a successful password login does:
   - Simha / Gala: the next-auth session for that user. The simplest way is a NextAuth Credentials provider `id: "lbv-sso"` whose `authorize()` does steps 1–3, plus a small page that calls `signIn("lbv-sso", { t, callbackUrl })`.
   - Booking: `createSession({ sub, email, pca })` from `lib/auth/session.ts`.
   - Also record it in the activity or audit log the way a login is recorded, with method "lbv-sso".
5. **Redirect:** to the admin home (`/admin`, or `/` for Gala).
6. **Security headers:** `Cache-Control: no-store`, and never log the token.
7. **Off switch:** if `LBV_SSO_SECRET` is not set, the route does nothing and redirects to the login page.

### Mobile WebView note
The pages run inside an Android WebView with cookies enabled. User agent contains `LBVCalls/`.
- Session cookies must stay `SameSite=Lax`, `Secure`, `HttpOnly`. Don't set `SameSite=Strict` on the session cookie, or the first request after the redirect will arrive without it.
- Please don't send people to Google sign-in from these admin pages.

### Tests to add
- valid token → logged in as the matching account
- wrong `aud` → rejected
- expired → rejected
- reused `jti` → rejected
- bad signature → rejected
- unknown email → login page, no account created
- disabled account → rejected

---

## מה יונתן צריך לעשות (פעם אחת)
1. לאשר את השינוי ולמזג אותו בשלושת המאגרים.
2. ב-Vercel של כל אחת משלוש המערכות, ב-Settings ואז Environment Variables, להוסיף `LBV_SSO_SECRET` עם אותו ערך ארוך ואקראי.
   מייצרים אותו פעם אחת, למשל עם `openssl rand -base64 48`.
3. להעביר את אותו ערך בדיוק לבעלים של LBV, בצורה פרטית ולא בקבוצה או במייל רגיל, כדי שיוסיף אותו גם ב-Vercel של lbv-portal.

## מה הבעלים של LBV עושה אחרי זה
1. ב-Vercel של lbv-portal: להוסיף `LBV_SSO_SECRET` עם אותו ערך ולעשות Redeploy.
2. בניהול האתר, תחת "מנהלים והרשאות": לכתוב לכל מנהל את המייל שיש לו בשמחה, בגאלה ובהרשמה לחגים, וגם את המייל של הבעלים.
3. לסמן לכל מנהל מה הוא רואה: שמחה, ערבי גאלה, הרשמה לחגים.

אחרי זה, לחיצה על "שמחה" באפליקציה נכנסת ישר לניהול של שמחה, בלי סיסמה.

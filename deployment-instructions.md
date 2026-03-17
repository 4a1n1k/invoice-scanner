# הוראות פריסה והעלאה לשרת (Deployment)

הפרויקט בנוי כרגע ומוכן להרצה!

## 1. העלאה ל-GitHub:
כדי להעלות את הפרויקט (שכרגע נמצא בתיקיית `invoice-scanner`) ל-GitHub:

```bash
git add .
git commit -m "Initial commit - Invoice Scanner App"
git branch -M main
# החלף את הלינק למטה בכתובת המאגר שלך בגיטהאב
git remote add origin https://github.com/USERNAME/REPOSITORY.git
git push -u origin main
```

## 2. פריסה לשרת (Docker):
כאשר אתה בשרת (לדוגמה דרך SSH), משוך את הפרויקט מהגיטהאב, ולאחר מכן הרץ את הדוקר. הקפד להגדיר את משתני הסביבה בסביבת השרת או בקובץ `.env` בשרת.

```bash
# בנה את הדימוי והפעל את הקונטיינר ברקע
docker-compose up -d --build
```
> [!NOTE] 
> הקונטיינר יחשוף את הפורט **3005** וישמור מידע בשני ווליומים (Volumes) מקומיים:
> - `storage/`: תקייה מקומית ששומרת העתקים של הקבצים שהועלו
> - `prisma/dev.db`: בסיס הנתונים SQLite של הפרויקט

האפליקציה תהיה זמינה בכתובת המקומית של השרת בפורט `3005`.

## דרישות מקדימות בייצור:
- `GOOGLE_CLIENT_ID` ו- `GOOGLE_CLIENT_SECRET`: חייבים להיות מוגדרים במסוף של גוגל, עם **Authorized redirect URIs** תקין המפנה ל- `https://yourdomain.com/api/auth/callback/google`.
- `AUTH_SECRET`: שים מחרוזת ארוכה אקראית כדי להצפין את פסי המעבר של NextAuth.
- עדכון כתובות ה-API של כלי ה-OCR וה-LLM (כפי שזה מוגדר כרגע בקוד, הפונים ל- 116.203.149.15).

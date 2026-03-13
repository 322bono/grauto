# Vercel 배포

이 프로젝트는 Next.js 서버 라우트를 사용하므로 Vercel에 그대로 배포하는 방식이 가장 간단합니다.

## 1. Vercel에 프로젝트 연결

1. [Vercel](https://vercel.com/)에 로그인합니다.
2. `Add New...` → `Project`를 누릅니다.
3. GitHub 저장소 `322bono/grauto`를 선택합니다.
4. Framework Preset은 `Next.js` 그대로 둡니다.
5. Root Directory, Build Command, Output Directory는 기본값 그대로 둡니다.

## 2. Environment Variables 넣기

Vercel 프로젝트 생성 화면이나, 생성 후 `Settings` → `Environment Variables`에서 아래 값을 한 줄씩 추가합니다.

### 꼭 넣어야 하는 값

```txt
Name: GEMINI_API_KEY
Value: 네 Gemini API 키

Name: GEMINI_MODEL
Value: gemini-2.5-flash

Name: NEXT_PUBLIC_FIREBASE_API_KEY
Value: 네 Firebase Web API Key

Name: NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
Value: justdance2-82ec4.firebaseapp.com

Name: NEXT_PUBLIC_FIREBASE_PROJECT_ID
Value: justdance2-82ec4

Name: NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID
Value: 411635221974

Name: NEXT_PUBLIC_FIREBASE_APP_ID
Value: 1:411635221974:web:26c32e0fbbed6eb05f9077

Name: CLOUDINARY_CLOUD_NAME
Value: 네 Cloudinary cloud name

Name: CLOUDINARY_API_KEY
Value: 네 Cloudinary API key

Name: CLOUDINARY_API_SECRET
Value: 네 Cloudinary API secret
```

### 체크 방식

- 각 변수는 `Production`, `Preview`, `Development`를 모두 체크해 두는 것을 권장합니다.
- `GEMINI_API_KEY`는 절대 `NEXT_PUBLIC_`를 붙이면 안 됩니다.
- `NEXT_PUBLIC_FIREBASE_*` 값은 웹앱 설정값이라 클라이언트에서 사용해도 됩니다.

## 3. Deploy

변수를 다 넣었으면 `Deploy`를 누릅니다.

## 4. Firebase에서 도메인 허용

Google 로그인을 쓰려면 Firebase 콘솔에서 Vercel 도메인을 허용해야 합니다.

1. Firebase Console → `Authentication`
2. `Settings`
3. `Authorized domains`
4. `your-project.vercel.app` 추가

커스텀 도메인을 쓰면 그 도메인도 같이 추가해야 합니다.

## 5. 로컬에서 먼저 확인

```bash
npm run typecheck
npm run build
```

## 최종 환경 변수 목록

```env
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-2.5-flash
NEXT_PUBLIC_FIREBASE_API_KEY=your_firebase_web_api_key
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=your-project-id
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=your_sender_id
NEXT_PUBLIC_FIREBASE_APP_ID=your_app_id
CLOUDINARY_CLOUD_NAME=your_cloudinary_cloud_name
CLOUDINARY_API_KEY=your_cloudinary_api_key
CLOUDINARY_API_SECRET=your_cloudinary_api_secret
```

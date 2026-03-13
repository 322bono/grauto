"use client";

import { getApp, getApps, initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

function requirePublicEnv(name: string) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} 환경 변수가 설정되지 않았습니다.`);
  }

  return value;
}

const firebaseConfig = {
  apiKey: requirePublicEnv("NEXT_PUBLIC_FIREBASE_API_KEY"),
  authDomain: requirePublicEnv("NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN"),
  projectId: requirePublicEnv("NEXT_PUBLIC_FIREBASE_PROJECT_ID"),
  messagingSenderId: requirePublicEnv("NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID"),
  appId: requirePublicEnv("NEXT_PUBLIC_FIREBASE_APP_ID")
};

const firebaseApp = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);

const auth = getAuth(firebaseApp);
const firestore = getFirestore(firebaseApp);
const googleProvider = new GoogleAuthProvider();

googleProvider.setCustomParameters({
  prompt: "select_account"
});

export { auth, firebaseApp, firestore, googleProvider };

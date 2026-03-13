"use client";

import { getApp, getApps, initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, type Auth } from "firebase/auth";
import { getFirestore, type Firestore } from "firebase/firestore";

function readPublicEnv(name: string) {
  return process.env[name] ?? "";
}

const firebaseConfig = {
  apiKey: readPublicEnv("NEXT_PUBLIC_FIREBASE_API_KEY"),
  authDomain: readPublicEnv("NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN"),
  projectId: readPublicEnv("NEXT_PUBLIC_FIREBASE_PROJECT_ID"),
  messagingSenderId: readPublicEnv("NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID"),
  appId: readPublicEnv("NEXT_PUBLIC_FIREBASE_APP_ID")
};

const firebaseConfigured = Object.values(firebaseConfig).every(Boolean);

const firebaseApp = firebaseConfigured ? (getApps().length > 0 ? getApp() : initializeApp(firebaseConfig)) : null;
const auth: Auth | null = firebaseApp ? getAuth(firebaseApp) : null;
const firestore: Firestore | null = firebaseApp ? getFirestore(firebaseApp) : null;
const googleProvider = firebaseConfigured ? new GoogleAuthProvider() : null;

googleProvider?.setCustomParameters({
  prompt: "select_account"
});

export { auth, firebaseApp, firebaseConfigured, firestore, googleProvider };

"use client";

import { getApp, getApps, initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, type Auth } from "firebase/auth";
import { getFirestore, type Firestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyBO7ca34vLXFfnx7kNwEfNpSBkq3d3D3Ik",
  authDomain: "justdance2-82ec4.firebaseapp.com",
  projectId: "justdance2-82ec4",
  storageBucket: "justdance2-82ec4.firebasestorage.app",
  messagingSenderId: "411635221974",
  appId: "1:411635221974:web:26c32e0fbbed6eb05f9077"
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

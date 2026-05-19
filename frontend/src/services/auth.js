import {
  CognitoUserPool,
  CognitoUser,
  AuthenticationDetails,
  CognitoUserAttribute,
} from 'amazon-cognito-identity-js';
import config from '../config';

const pool = new CognitoUserPool({
  UserPoolId: config.cognito.userPoolId,
  ClientId: config.cognito.userPoolWebClientId,
});

export function signUp(email, password) {
  return new Promise((resolve, reject) => {
    const attrs = [new CognitoUserAttribute({ Name: 'email', Value: email })];
    pool.signUp(email, password, attrs, null, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

export function confirmSignUp(email, code) {
  return new Promise((resolve, reject) => {
    const user = new CognitoUser({ Username: email, Pool: pool });
    user.confirmRegistration(code, true, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

export function signIn(email, password) {
  return new Promise((resolve, reject) => {
    const user = new CognitoUser({ Username: email, Pool: pool });
    const auth = new AuthenticationDetails({ Username: email, Password: password });
    user.authenticateUser(auth, {
      onSuccess: resolve,
      onFailure: reject,
      newPasswordRequired: () => {
        const err = new Error('A password reset is required for this account. Please contact support or re-register.');
        err.code = 'NewPasswordRequired';
        reject(err);
      },
    });
  });
}

export function signOut() {
  const user = pool.getCurrentUser();
  if (user) user.signOut();
}

function getSession() {
  return new Promise((resolve, reject) => {
    const user = pool.getCurrentUser();
    if (!user) return resolve(null);
    user.getSession((err, session) => {
      if (err || !session.isValid()) return resolve(null);
      resolve(session);
    });
  });
}

export async function getIdToken() {
  const session = await getSession();
  return session ? session.getIdToken().getJwtToken() : null;
}

export async function getAccessToken() {
  const session = await getSession();
  return session ? session.getAccessToken().getJwtToken() : null;
}

export async function isAuthenticated() {
  const session = await getSession();
  return session !== null;
}

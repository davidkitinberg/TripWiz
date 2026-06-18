/**
 * @fileoverview Frontend environment configuration for API Gateway, WebSocket, and Cognito.
 * @authors David Kitinberg, Amit Bitton, Sagi Hassid
 */

const config = {
  region: 'us-east-1',
  cognito: {
    userPoolId: 'us-east-1_BDUbabdwy',
    userPoolWebClientId: '16pliujl3rounkj240umgd553o',
  },
  api: {
    baseUrl: 'https://ln2dwp4q3l.execute-api.us-east-1.amazonaws.com/prod',
  },
  websocket: {
    url: 'wss://g4cm9h17wk.execute-api.us-east-1.amazonaws.com/prod',
  },
};

export default config;

/**
 * @fileoverview WebSocket authorizer Lambda validating Cognito access tokens on connect.
 * @authors David Kitinberg, Amit Bitton, Sagi Hassid
 */

const { CognitoIdentityProviderClient, GetUserCommand } = require('@aws-sdk/client-cognito-identity-provider');

const cognito = new CognitoIdentityProviderClient({});

function buildPolicy(effect, routeArn, principalId, context) {
  return {
    principalId: principalId || 'anonymous',
    policyDocument: {
      Version: '2012-10-17',
      Statement: [{
        Action: 'execute-api:Invoke',
        Effect: effect,
        Resource: routeArn
      }]
    },
    context: context || {}
  };
}

function extractToken(event) {
  const headers = event.headers || {};
  const authHeader = headers.Authorization || headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) return authHeader.slice(7);
  return event.queryStringParameters && event.queryStringParameters.token;
}

// [Feature #29] WebSocket authorizer — validate the Cognito token before allowing connect
exports.handler = async (event) => {
  const routeArn = event.methodArn || event.routeArn;
  const token = extractToken(event);
  if (!token) return buildPolicy('Deny', routeArn);

  try {
    const user = await cognito.send(new GetUserCommand({ AccessToken: token }));
    const subAttr = (user.UserAttributes || []).find((attr) => attr.Name === 'sub');
    const sub = (subAttr && subAttr.Value) || user.Username;
    return buildPolicy('Allow', routeArn, sub, { sub, username: user.Username });
  } catch (err) {
    console.warn('WebSocket authorizer rejected token', err.name || err.message);
    return buildPolicy('Deny', routeArn);
  }
};

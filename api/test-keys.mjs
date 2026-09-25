import handleRequest from '../server.mjs';

export default async function handler(req, res) {
  req.url = '/api/test-keys';
  return handleRequest(req, res);
}

import handleRequest from '../server.mjs';

export default async function handler(req, res) {
  req.url = '/api/status';
  return handleRequest(req, res);
}

import handleRequest from '../server.mjs';

export default async function handler(req, res) {
  const query = req.url && req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  req.url = '/api/download-trailer' + query;
  return handleRequest(req, res);
}

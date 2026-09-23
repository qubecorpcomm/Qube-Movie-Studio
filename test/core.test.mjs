import assert from 'node:assert/strict';
import test from 'node:test';
import { langCode, norm, youtubeURL, rankImages, parseMovieListText, generateNewsletterHTML } from '../public/core.mjs';

test('langCode normalizes language strings', () => {
  assert.equal(langCode('English'), 'en');
  assert.equal(langCode('es'), 'es');
  assert.equal(langCode(''), '');
});

test('norm cleans up strings for matching', () => {
  assert.equal(norm('Inception (2010)!'), 'inception2010');
  assert.equal(norm('  Élite  '), 'elite');
});

test('youtubeURL constructs valid watch links', () => {
  assert.equal(youtubeURL('dQw4w9WgXcQ'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(youtubeURL('https://www.youtube.com/watch?v=abc'), 'https://www.youtube.com/watch?v=abc');
});

test('parseMovieListText handles various list formats', () => {
  const input = 'Inception (2010)\nInterstellar, 2014\nOppenheimer';
  const movies = parseMovieListText(input);
  assert.equal(movies.length, 3);
  assert.equal(movies[0].title, 'Inception');
  assert.equal(movies[0].year, '2010');
  assert.equal(movies[1].title, 'Interstellar');
  assert.equal(movies[1].year, '2014');
  assert.equal(movies[2].title, 'Oppenheimer');
});

test('generateNewsletterHTML outputs HTML string', () => {
  const html = generateNewsletterHTML([{ title: 'Dune', year: '2021', overview: 'Desert power' }]);
  assert.ok(html.includes('Dune'));
  assert.ok(html.includes('Desert power'));
});

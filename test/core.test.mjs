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

test('parseMovieListText handles Qube Wire OCR report format and keeps distributor clean of CPL details', () => {
  const ocrReport = `
Avengers Endgame: Encore (2026), English – IMAX 5
Distributor: IMAX \t AvengEndgamEnc-IMX_FTR-L-2D_C_EN-EN-CCAP_INT-TD_IMAX5-HI-VI_4K_MRV_20260912_IMX_SMPTE_OV

AvengEndgamEnc-IMX_FTR-L-2D_C_EN-EN-CCAP_INT-TD_IMAX5-HI-VI_4K_MRV_20260912_IMX_SMPTE_OV

First Frame End Credits: 02:51:07
First Frame Moving Credits: 02:56:55
Feature Film Duration: 03:06:44
CPL Part 1 Duration: 01:30:00
CPL Part 2 Duration: 01:36:44
  `;
  const movies = parseMovieListText(ocrReport);
  assert.equal(movies.length, 1);
  assert.equal(movies[0].title, 'Avengers Endgame: Encore');
  assert.equal(movies[0].year, '2026');
  assert.equal(movies[0].distributor, 'IMAX');
  assert.equal(movies[0].featureDuration, '03:06:44');
  assert.equal(movies[0].firstFrameEndCredits, '02:51:07');
  assert.ok(!movies[0].distributor.includes('FTR'));
  assert.ok(!movies[0].distributor.includes('CPL'));
});

test('generateNewsletterHTML outputs HTML string with custom accent color and font family without CPL Part 1 or Part 2', () => {
  const movie = {
    title: 'Dune',
    year: '2021',
    cpls: [{ name: 'Dune_FTR_2D' }],
    cpl_part1_duration: '01:15:00',
    cpl_part2_duration: '01:20:00',
    first_frame_end_credits: '02:25:00',
    first_frame_moving_credits: '02:30:00'
  };
  const html = generateNewsletterHTML([movie], { layoutTemplate: 'theatrical-bulletin', accentColor: '#e11d48' });
  assert.ok(html.includes('Dune'));
  assert.ok(html.includes('Dune_FTR_2D'));
  assert.ok(html.includes('First Frame End Credits:'));
  // Ensure CPL Part 1 and Part 2 are NOT in newsletter
  assert.ok(!html.includes('CPL Part 1 Duration:'));
  assert.ok(!html.includes('CPL Part 2 Duration:'));

  const htmlOne = generateNewsletterHTML([{ title: 'Dune', year: '2021' }], { layoutTemplate: 'one-column', accentColor: '#e11d48', fontFamily: 'serif' });
  assert.ok(htmlOne.includes('Dune'));
  assert.ok(htmlOne.includes('#e11d48'));
  assert.ok(htmlOne.includes('Georgia'));

  const htmlTwo = generateNewsletterHTML([{ title: 'Movie 1' }, { title: 'Movie 2' }], { layoutTemplate: 'two-column', accentColor: '#10b981', fontFamily: 'monospace' });
  assert.ok(htmlTwo.includes('Movie 1'));
  assert.ok(htmlTwo.includes('Movie 2'));
  assert.ok(htmlTwo.includes('#10b981'));
  assert.ok(htmlTwo.includes('Courier New'));
  assert.ok(htmlTwo.includes('width=\'50%\''));
});

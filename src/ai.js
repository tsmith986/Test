// Optional AI copywriting: turns the facts you've gathered about a business
// into website copy. Needs an Anthropic API key (Settings page or env var).
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';

export const MODEL = 'claude-opus-5-5';

const SiteCopy = z.object({
  tagline: z.string().describe('Short hero line, under 12 words'),
  about: z.string().describe('2–4 warm, specific sentences about the business'),
  services: z
    .array(
      z.object({
        name: z.string(),
        description: z.string().describe('One sentence'),
        price: z.string().describe('Keep any known price; otherwise empty string'),
      }),
    )
    .describe('4–8 services the business plausibly offers, starting with any already listed'),
  hoursText: z.string().describe('Opening hours, one line per day or range, e.g. "Mon–Fri: 9am–6pm". Empty if unknown.'),
});

export async function writeSiteCopy({ apiKey, business, services, hoursText, reviews, notes }) {
  if (!apiKey) throw new Error('Add an Anthropic API key in Settings to use AI copywriting.');
  const client = new Anthropic({ apiKey });

  const facts = {
    name: business.name,
    category: business.category,
    address: business.address,
    phone: business.phone,
    existingTagline: business.tagline,
    existingAbout: business.about,
    existingServices: services,
    openingHours: hoursText,
    customerReviews: (reviews || []).map((r) => r.text).filter(Boolean),
    extraNotes: notes,
  };

  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: 'low', format: betaZodOutputFormat(SiteCopy) },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system:
      'You write website copy for small local businesses. Be concrete and friendly, never generic marketing filler. ' +
      'Only state facts that appear in the provided information or are obviously true of this kind of business; never invent awards, years in business, staff names, or prices. ' +
      'If opening hours are given in OpenStreetMap syntax (e.g. "Mo-Fr 09:00-17:00"), rewrite them in plain English.',
    messages: [
      {
        role: 'user',
        content: `Write the copy for this business's one-page website.\n\n${JSON.stringify(facts, null, 2)}`,
      },
    ],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error('The AI declined to write copy for this business. Try editing the details and retry.');
  }
  if (!response.parsed_output) {
    throw new Error(`The AI response could not be used (stop reason: ${response.stop_reason}).`);
  }
  return response.parsed_output;
}

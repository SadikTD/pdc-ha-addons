// Every rule the add-on knows, each tied to the exact line of the guide it comes from
// (`quote` must appear word for word in that guide; catalog.test.mjs checks it).
// by: 'code' (measured), 'ai' (judged by the model against the guide text), 'manual'
// (can't be checked from the outside; listed so nobody thinks it is).
export const RULES = {
  // Pitch
  'pitch.sources': { stage: 'pitch', by: 'code', guide: 'stories', title: 'Sources on the card', quote: 'The description says what the video or article is about.' },
  'pitch.description': { stage: 'pitch', by: 'code', guide: 'stories', title: 'Description on the card', quote: 'The description says what the video or article is about.' },
  'pitch.post-date': { stage: 'pitch', by: 'code', guide: 'stories', title: 'Original post date on the card', quote: 'Original post date is written on the card. (Needed for every TikTok, X, Reddit and YouTube pitch.)' },
  'pitch.fresh': { stage: 'pitch', by: 'code', guide: 'stories', title: 'Fresh enough', quote: 'Is it fresh enough? News: under 24 hours. Social stories: up to a week.' },
  'pitch.three-cs': { stage: 'pitch', by: 'ai', guide: 'stories', title: 'Hits one of the three Cs', quote: 'Every pitch must hit at least one of the three Cs:' },
  'pitch.dont-pitch': { stage: 'pitch', by: 'ai', guide: 'stories', title: 'Not on the "Don\'t pitch" list', quote: 'Guides, lists (“5 reasons why…”) or opinion pieces.' },
  'pitch.sensitive': { stage: 'pitch', by: 'ai', guide: 'stories', title: 'Sensitive topic as the main topic', quote: 'Religion, LGBTQ+ and medical topics can only be mentioned in rare cases, with high-level approval, when they’re part of a bigger story.' },
  'pitch.real': { stage: 'pitch', by: 'ai', guide: 'stories', title: 'Real news, real account, new video', quote: 'The account is real, and the video is actually new, not an old one reposted.' },
  'pitch.one-sided': { stage: 'pitch', by: 'ai', guide: 'stories', title: 'One-sided story', quote: 'Allowed, but always hedge. Say we couldn’t hear the other side.' },

  // Headline (pitch title and published headline)
  'headline.case': { stage: 'both', by: 'code', guide: 'headlines', title: 'Sentence case', quote: 'Sentence case. Capitalize it like a normal sentence.' },
  'headline.length': { stage: 'both', by: 'code', guide: 'headlines', title: 'Under 150 characters', quote: 'Under 150 characters. The board won’t let you go over.' },
  'headline.dashes': { stage: 'both', by: 'code', guide: 'headlines', title: 'No hyphens or dashes', quote: 'No hyphens or dashes. They get cut off in partner feeds.' },
  'headline.quotes': { stage: 'both', by: 'code', guide: 'headlines', title: 'Single quotes', quote: 'Single quotes for quotes: ‘Pure evil’, not “Pure evil”.' },
  'headline.colon': { stage: 'both', by: 'code', guide: 'headlines', title: 'No colon joining two headlines', quote: 'No colon joining two headlines into one.' },
  'headline.bad-words': { stage: 'both', by: 'code', guide: 'headlines', title: 'No bad words', quote: 'No bad words. If it was a bad word when you were nine, it’s out. That includes drug names.' },
  'headline.sa': { stage: 'both', by: 'code', guide: 'headlines', title: '"SA" in headlines', quote: 'For sexual assault, write “SA,” never “rape” or “molestation.”' },
  'headline.source-only': { stage: 'both', by: 'ai', guide: 'headlines', title: 'Only what\'s in the source', quote: 'Only what’s in the source. Watch the video yourself. If it doesn’t show it, the headline can’t say it, even if another outlet did.' },
  'headline.commenter-quote': { stage: 'both', by: 'ai', guide: 'headlines', title: 'No commenter quotes', quote: 'No commenter quotes in the headline. A quote in the title must come from someone in the story.' },
  'headline.hedge': { stage: 'both', by: 'ai', guide: 'headlines', title: 'Hedge anything unproven', quote: 'Hedge anything unproven. For rumors, use “reportedly” or “suggests,” never “confirmed” or “revealed.”' },

  // Article shape and style
  'format.shape': { stage: 'article', by: 'code', guide: 'quickref', title: 'Article shape', quote: 'Three paragraphs, then the H2, then a paragraph, then the embed' },
  'format.words': { stage: 'article', by: 'code', guide: 'format', title: '400 words minimum', quote: '400 words minimum. If the story is short, add real context (backstory, laws, the people involved). Never add fluff.' },
  'format.two-sentences': { stage: 'article', by: 'code', guide: 'format', title: 'Two sentences per paragraph', quote: 'Two sentences minimum. Only the very last paragraph can be one sentence.' },
  'format.five-lines': { stage: 'article', by: 'code', guide: 'format', title: 'Five lines per paragraph', quote: 'Five lines maximum (lines, not sentences). If it’s longer, split it.' },
  'format.openers': { stage: 'article', by: 'code', guide: 'format', title: 'No And, But or Moreover openers', quote: 'Don’t start a sentence with “And,” “But” or “Moreover.”' },
  'format.however': { stage: 'article', by: 'code', guide: 'format', title: '"However" never starts a paragraph', quote: '“However” can start a sentence, but never a paragraph.' },
  'format.h2': { stage: 'article', by: 'code', guide: 'format', title: 'H2 style', quote: 'The H2 is sentence case with no period at the end, and it’s never a fan tweet or comment.' },
  'format.h2-comment': { stage: 'article', by: 'ai', guide: 'format', title: 'H2 is a comment, not a title', quote: 'An H2 is a comment, not a title. Test: would you text it to a friend?' },
  'format.pyramid': { stage: 'article', by: 'ai', guide: 'format', title: 'Answer at the top', quote: 'Don’t bury the answer. If the headline makes the reader ask “what happened?”, the first paragraphs answer it.' },
  'format.dates': { stage: 'article', by: 'code', guide: 'format', title: 'No dates unless needed', quote: 'No dates unless the story needs one. A reader tomorrow will think a dated article is old.' },
  'format.units': { stage: 'article', by: 'code', guide: 'format', title: 'American units', quote: 'American units: miles, feet, pounds, Fahrenheit, US dollars.' },
  'format.numbers': { stage: 'article', by: 'code', guide: 'format', title: 'Numbers one to nine spelled out', quote: 'Numbers: write out one to nine; use digits from 10 up.' },
  'format.titles': { stage: 'article', by: 'ai', guide: 'format', title: 'Italics for titles, not outlets', quote: 'Italicize titles of movies, shows, books and songs' },
  'format.source-once': { stage: 'article', by: 'ai', guide: 'format', title: 'Name the source once', quote: 'Name your source once, then move on' },
  'format.source-link-text': { stage: 'article', by: 'code', guide: 'format', title: 'Link only the source\'s name', quote: 'Link only the source’s name' },
  'format.handles': { stage: 'article', by: 'code', guide: 'format', title: '@ the first time only', quote: 'TikTok users: @ the first time only' },
  'format.curses': { stage: 'article', by: 'code', guide: 'format', title: 'Curse words censored', quote: 'Censor curse words (first letter + stars, or all stars)' },
  'format.past-tense': { stage: 'article', by: 'ai', guide: 'format', title: 'Past tense', quote: 'Past tense for things that already happened.' },
  'source.linked': { stage: 'article', by: 'code', guide: 'quickref', title: 'Source named and linked early', quote: 'Source named and linked in the first three paragraphs' },
  'source.original': { stage: 'article', by: 'ai', guide: 'value', title: 'Cite the original', quote: 'Cite the original. If a news site is quoting a TikTok, link the TikTok, not the news site.' },

  // Content and accuracy
  'value.add': { stage: 'article', by: 'ai', guide: 'value', title: 'Adds something new', quote: 'Only describing what’s in the video is against our rules and our partners’ rules.' },
  'value.comments': { stage: 'article', by: 'ai', guide: 'value', title: 'Comments used rarely', quote: 'Never write a whole section about comments.' },
  'value.comment-balance': { stage: 'article', by: 'ai', guide: 'value', title: 'Balanced comments', quote: 'Each negative comment needs a positive one to balance it.' },
  'value.tone': { stage: 'article', by: 'ai', guide: 'value', title: 'Neutral tone', quote: 'Tone: we report the drama, we don’t join it' },
  'value.apparently': { stage: 'article', by: 'code', guide: 'value', title: 'Words to avoid', quote: 'Also avoid: too many colons, “apparently,” saying the same thing twice, sounding stiff or robotic, and random bold text.' },
  'value.alleged': { stage: 'article', by: 'ai', guide: 'value', title: 'Charged is not convicted', quote: 'Keep the hedging the whole way through the article, not just the first time.' },
  'value.police': { stage: 'article', by: 'ai', guide: 'value', title: 'Police reports are claims', quote: 'Police reports are claims too: write “a police report claims,” not “police revealed.”' },
  'value.minor': { stage: 'article', by: 'ai', guide: 'value', title: 'Never name an accused minor', quote: 'Never name a minor who is accused of a crime.' },
  'value.quotes': { stage: 'article', by: 'ai', guide: 'value', title: 'Exact quotes from the source', quote: 'Quotes must be exact. Check them against the video or article word for word. If you can’t confirm it, don’t use it as a quote. Quotes only come from the source, never from the comments.' },
  'value.other-side': { stage: 'article', by: 'ai', guide: 'value', title: 'The other side', quote: 'Don’t leave out the other side. If someone responded, include it. If they didn’t respond, say so.' },
  'value.claims-linked': { stage: 'article', by: 'ai', guide: 'value', title: 'Every claim linked', quote: 'Every claim needs a link. Even “videos circulating on TikTok” needs one.' },
  'value.sensitive': { stage: 'article', by: 'ai', guide: 'stories', title: 'Sensitive topics', quote: 'Religion, LGBTQ+ and medical topics can only be mentioned in rare cases, with high-level approval, when they’re part of a bigger story.' },

  // Interlinks
  'links.count': { stage: 'article', by: 'code', guide: 'interlinks', title: 'Enough interlinks', quote: 'Most sites need at least two in every article. Attack of the Fanboy needs one.' },
  'links.anchor-length': { stage: 'article', by: 'code', guide: 'interlinks', title: 'Anchor 3 to 5 words', quote: 'The linked words (the “anchor text”) should be 3 to 5 words, 7 at most.' },
  'links.repeat': { stage: 'article', by: 'code', guide: 'interlinks', title: 'No repeated links', quote: 'Never use the same link twice in one article.' },
  'links.same-paragraph': { stage: 'article', by: 'code', guide: 'interlinks', title: 'One link per paragraph', quote: 'Never put two links in the same paragraph.' },
  'links.click-here': { stage: 'article', by: 'code', guide: 'interlinks', title: 'No "click here"', quote: 'No “click here” or “read more.”' },
  'links.anchor-describes': { stage: 'article', by: 'ai', guide: 'interlinks', title: 'Anchor describes the story', quote: 'They must describe what happens in the other story, not just who it’s about.' },
  'links.u-turn': { stage: 'article', by: 'ai', guide: 'interlinks', title: 'No U-turns', quote: 'A U-turn is when the article suddenly talks about something else just to fit a link.' },
  'links.crime': { stage: 'article', by: 'ai', guide: 'interlinks', title: 'No light story tied to crime', quote: 'Never tie a light story to a crime, abuse or Epstein story. It makes the person look guilty by association.' },
  'links.similar-to': { stage: 'article', by: 'ai', guide: 'interlinks', title: '"Similar to" only when connected', quote: 'Don’t write “similar to” or “along with” unless the stories really are connected.' },

  // Embeds
  'embed.rendered': { stage: 'article', by: 'code', guide: 'wordpress', title: 'Embed turned into a player', quote: 'A plain Facebook link won’t turn into an embed. You need to copy Facebook’s embed code and paste it into a Custom HTML block.' },
  'embed.instagram': { stage: 'article', by: 'ai', guide: 'wordpress', title: 'No celebrity Instagram', quote: 'Never embed a celebrity’s Instagram.' },
  'embed.curses': { stage: 'article', by: 'code', guide: 'wordpress', title: 'No cursing in the embed', quote: 'Cursing in the post? Use a censored screenshot instead and link the embed somewhere near it.' },

  // Featured image
  'image.present': { stage: 'article', by: 'code', guide: 'quickref', title: 'Featured image', quote: 'From the Imager, 1280 x 720, matches the headline' },
  'image.size': { stage: 'article', by: 'code', guide: 'wordpress', title: '1280 x 720', quote: 'Size: 1280 x 720.' },
  'image.imager': { stage: 'article', by: 'code', guide: 'wordpress', title: 'From the Imager', quote: 'Use the Imager. It’s NOT OPTIONAL.' },
  'image.title': { stage: 'article', by: 'code', guide: 'wordpress', title: 'Image title describes the picture', quote: 'Title: describe what’s happening in the picture. No date, no place.' },
  'image.credit': { stage: 'article', by: 'code', guide: 'wordpress', title: 'Image credit', quote: 'Credit: “Image by ___” plus the license, like: Image by TheBetterDay, CC BY-ND 2.0.' },
  'image.instagram': { stage: 'article', by: 'code', guide: 'wordpress', title: 'No Instagram image', quote: 'Never use an Instagram image as the featured image.' },
  'image.matches': { stage: 'article', by: 'ai', guide: 'wordpress', title: 'Image matches the headline', quote: 'The image must match the headline. If the headline names a person, show that person.' },
  'image.banned': { stage: 'article', by: 'ai', guide: 'wordpress', title: 'MSN and NewsBreak banned list', quote: 'Any visible gun. No exceptions, even for real news.' },
  'image.mugshot': { stage: 'article', by: 'ai', guide: 'wordpress', title: 'Mugshots only once charged', quote: 'Never use a mugshot or bodycam image unless the person has been officially charged.' },
  'image.animated': { stage: 'article', by: 'ai', guide: 'wordpress', title: 'No animated-movie stills', quote: 'Avoid stills from animated movies as the featured image; they don’t perform.' },

  // WordPress
  'seo.title': { stage: 'article', by: 'code', guide: 'wordpress', title: 'SEO title filled in', quote: 'SEO: fill in the SEO title, nothing else' },
  'seo.format': { stage: 'article', by: 'code', guide: 'wordpress', title: 'SEO title format', quote: 'Anything with the site name, a pipe ( | ) or a colon' },
  'seo.case': { stage: 'article', by: 'code', guide: 'wordpress', title: 'SEO title sentence case', quote: 'The SEO title is sentence case too.' },
  'seo.question': { stage: 'article', by: 'ai', guide: 'wordpress', title: 'SEO title someone would search', quote: 'It’s a short sentence someone would actually type into Google.' },
  'seo.meta': { stage: 'article', by: 'code', guide: 'wordpress', title: 'Nothing else in the SEO section', quote: 'Leave every other SEO box empty: no meta description, no focus keyphrase.' },
  'tags.present': { stage: 'article', by: 'code', guide: 'wordpress', title: 'Has tags', quote: 'Always add tags. An article with no tags isn’t finished.' },
  'tags.existing': { stage: 'article', by: 'code', guide: 'wordpress', title: 'Existing tags only', quote: 'Only use tags that already exist. Never create a new one.' },
  'tags.names': { stage: 'article', by: 'ai', guide: 'wordpress', title: 'Tags are names', quote: 'Never common nouns (“customer,” “wedding,” “video”).' },
  'category.primary': { stage: 'article', by: 'code', guide: 'wordpress', title: 'Primary category', quote: 'The primary category is always News.' },
  'category.topic': { stage: 'article', by: 'code', guide: 'wordpress', title: 'Topic as second category', quote: 'Add the topic as the second category (for example, True Crime, Politics).' },

  // Can't be checked from outside the newsroom
  'manual.notes': { stage: 'article', by: 'manual', guide: 'quickref', title: 'Old revision notes', quote: 'Read your old notes. A note on one article is a note for all of them.' },
  'manual.watched': { stage: 'pitch', by: 'manual', guide: 'headlines', title: 'Watched the video', quote: 'Watch the video yourself.' },
  'manual.focus': { stage: 'article', by: 'manual', guide: 'wordpress', title: 'Focus keyphrase empty', quote: 'Leave every other SEO box empty: no meta description, no focus keyphrase.' },
  'manual.grace': { stage: 'article', by: 'manual', guide: 'wordpress', title: 'grace-pitch internal tag', quote: 'If you’re writing a pitch that Grace (the Assigning Editor) gave out on the board, select grace-pitch in the internal tags.' },
};

// The AI may only use rule ids from this list, per stage.
export const aiRules = stage => Object.entries(RULES).filter(([, r]) => r.by === 'ai' && (r.stage === stage || r.stage === 'both')).map(([id, r]) => ({ id, ...r }));

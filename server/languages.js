// Everything VoiceDesk knows about each language it speaks: names, phone
// voices (female / male), the line used in the "choose your language" menu,
// a default greeting, and the fixed phrases said by the phone system itself.
//
// Phone voices are Twilio <Say> Google voices; speech recognition uses the
// same language code in <Gather>. The translations were written for this
// product: have a native speaker review them before launch (docs/LEARN.md).
//
// In templates, {n} is the menu key to press, {org} the business name and
// {name} the customer's first name (with a leading space) or nothing.

export const LANGUAGE_DATA = [
  {
    code: "en-IN", name: "English (India)", native: "English", script: "Latin",
    voices: { female: "Google.en-IN-Neural2-A", male: "Google.en-IN-Neural2-B" },
    keywords: ["english", "angrezi", "inglish"],
    menu: "For English, press {n}.",
    greeting: "Hello! Thank you for calling {org}. How can I help you today?",
    phrases: {
      retry: "Sorry, I didn't catch that. Could you say it again?",
      noInput: "I can't hear anything, so I'll hang up now. Please call again. Goodbye.",
      connecting: "One moment, I'm connecting you to our team.",
      chosen: "Sure, let's continue in English.",
      chat: "Hi! I'm the AI assistant for {org}. How can I help you today?",
      aiCall: "Hello{name}, this is an AI assistant calling from {org}.",
    },
  },
  {
    code: "hi-IN", name: "Hindi", native: "हिन्दी", script: "Devanagari",
    voices: { female: "Google.hi-IN-Neural2-A", male: "Google.hi-IN-Neural2-B" },
    keywords: ["hindi", "हिंदी", "हिन्दी"],
    menu: "हिंदी के लिए {n} दबाइए।",
    greeting: "नमस्ते! {org} में कॉल करने के लिए धन्यवाद। मैं आपकी क्या मदद कर सकती हूँ?",
    phrases: {
      retry: "माफ़ कीजिए, मैं सुन नहीं पाई। क्या आप फिर से बोल सकते हैं?",
      noInput: "मुझे कुछ सुनाई नहीं दे रहा, इसलिए मैं कॉल रख रही हूँ। कृपया फिर से कॉल करें। धन्यवाद।",
      connecting: "एक पल रुकिए, मैं आपको हमारी टीम से जोड़ रही हूँ।",
      chosen: "ज़रूर, अब हम हिंदी में बात करते हैं।",
      chat: "नमस्ते! मैं {org} की AI सहायक हूँ। मैं आपकी क्या मदद कर सकती हूँ?",
      aiCall: "नमस्ते{name}, मैं {org} की ओर से AI सहायक बोल रही हूँ।",
    },
  },
  {
    code: "ta-IN", name: "Tamil", native: "தமிழ்", script: "Tamil",
    voices: { female: "Google.ta-IN-Standard-A", male: "Google.ta-IN-Standard-B" },
    keywords: ["tamil", "தமிழ்"],
    menu: "தமிழுக்கு {n} ஐ அழுத்தவும்.",
    greeting: "வணக்கம்! {org}-ஐ அழைத்ததற்கு நன்றி. நான் உங்களுக்கு எப்படி உதவலாம்?",
    phrases: {
      retry: "மன்னிக்கவும், எனக்கு சரியாகக் கேட்கவில்லை. மீண்டும் சொல்ல முடியுமா?",
      noInput: "எனக்கு எதுவும் கேட்கவில்லை, அதனால் அழைப்பை முடிக்கிறேன். தயவுசெய்து மீண்டும் அழைக்கவும். நன்றி.",
      connecting: "ஒரு நிமிடம், உங்களை எங்கள் குழுவுடன் இணைக்கிறேன்.",
      chosen: "சரி, இனி தமிழில் பேசலாம்.",
      chat: "வணக்கம்! நான் {org}-இன் AI உதவியாளர். நான் உங்களுக்கு எப்படி உதவலாம்?",
      aiCall: "வணக்கம்{name}, நான் {org} சார்பாக அழைக்கும் AI உதவியாளர்.",
    },
  },
  {
    code: "te-IN", name: "Telugu", native: "తెలుగు", script: "Telugu",
    voices: { female: "Google.te-IN-Standard-A", male: "Google.te-IN-Standard-B" },
    keywords: ["telugu", "తెలుగు"],
    menu: "తెలుగు కోసం {n} నొక్కండి.",
    greeting: "నమస్కారం! {org}కి కాల్ చేసినందుకు ధన్యవాదాలు. నేను మీకు ఎలా సహాయం చేయగలను?",
    phrases: {
      retry: "క్షమించండి, నాకు సరిగ్గా వినిపించలేదు. మళ్ళీ చెప్పగలరా?",
      noInput: "నాకు ఏమీ వినిపించడం లేదు, కాబట్టి కాల్ ముగిస్తున్నాను. దయచేసి మళ్ళీ కాల్ చేయండి. ధన్యవాదాలు.",
      connecting: "ఒక్క నిమిషం, మిమ్మల్ని మా టీమ్‌తో కలుపుతున్నాను.",
      chosen: "సరే, ఇప్పుడు తెలుగులో మాట్లాడుకుందాం.",
      chat: "నమస్కారం! నేను {org} యొక్క AI అసిస్టెంట్‌ని. నేను మీకు ఎలా సహాయం చేయగలను?",
      aiCall: "నమస్కారం{name}, నేను {org} తరపున కాల్ చేస్తున్న AI అసిస్టెంట్‌ని.",
    },
  },
  {
    code: "kn-IN", name: "Kannada", native: "ಕನ್ನಡ", script: "Kannada",
    voices: { female: "Google.kn-IN-Standard-A", male: "Google.kn-IN-Standard-B" },
    keywords: ["kannada", "ಕನ್ನಡ"],
    menu: "ಕನ್ನಡಕ್ಕಾಗಿ {n} ಒತ್ತಿರಿ.",
    greeting: "ನಮಸ್ಕಾರ! {org}ಗೆ ಕರೆ ಮಾಡಿದ್ದಕ್ಕೆ ಧನ್ಯವಾದಗಳು. ನಾನು ನಿಮಗೆ ಹೇಗೆ ಸಹಾಯ ಮಾಡಲಿ?",
    phrases: {
      retry: "ಕ್ಷಮಿಸಿ, ನನಗೆ ಸರಿಯಾಗಿ ಕೇಳಿಸಲಿಲ್ಲ. ದಯವಿಟ್ಟು ಮತ್ತೊಮ್ಮೆ ಹೇಳುತ್ತೀರಾ?",
      noInput: "ನನಗೆ ಏನೂ ಕೇಳಿಸುತ್ತಿಲ್ಲ, ಆದ್ದರಿಂದ ಕರೆ ಮುಗಿಸುತ್ತಿದ್ದೇನೆ. ದಯವಿಟ್ಟು ಮತ್ತೆ ಕರೆ ಮಾಡಿ. ಧನ್ಯವಾದಗಳು.",
      connecting: "ಒಂದು ನಿಮಿಷ, ನಿಮ್ಮನ್ನು ನಮ್ಮ ತಂಡಕ್ಕೆ ಸಂಪರ್ಕಿಸುತ್ತಿದ್ದೇನೆ.",
      chosen: "ಸರಿ, ಈಗ ಕನ್ನಡದಲ್ಲಿ ಮಾತನಾಡೋಣ.",
      chat: "ನಮಸ್ಕಾರ! ನಾನು {org} ನ AI ಸಹಾಯಕಿ. ನಾನು ನಿಮಗೆ ಹೇಗೆ ಸಹಾಯ ಮಾಡಲಿ?",
      aiCall: "ನಮಸ್ಕಾರ{name}, ನಾನು {org} ಪರವಾಗಿ ಕರೆ ಮಾಡುತ್ತಿರುವ AI ಸಹಾಯಕಿ.",
    },
  },
  {
    code: "ml-IN", name: "Malayalam", native: "മലയാളം", script: "Malayalam",
    voices: { female: "Google.ml-IN-Standard-A", male: "Google.ml-IN-Standard-B" },
    keywords: ["malayalam", "മലയാളം"],
    menu: "മലയാളത്തിന് {n} അമർത്തുക.",
    greeting: "നമസ്കാരം! {org}-ലേക്ക് വിളിച്ചതിന് നന്ദി. ഞാൻ നിങ്ങളെ എങ്ങനെ സഹായിക്കട്ടെ?",
    phrases: {
      retry: "ക്ഷമിക്കണം, എനിക്ക് വ്യക്തമായി കേട്ടില്ല. ഒന്നുകൂടി പറയാമോ?",
      noInput: "എനിക്ക് ഒന്നും കേൾക്കുന്നില്ല, അതിനാൽ കോൾ അവസാനിപ്പിക്കുന്നു. ദയവായി വീണ്ടും വിളിക്കൂ. നന്ദി.",
      connecting: "ഒരു നിമിഷം, നിങ്ങളെ ഞങ്ങളുടെ ടീമുമായി ബന്ധിപ്പിക്കുന്നു.",
      chosen: "ശരി, ഇനി മലയാളത്തിൽ സംസാരിക്കാം.",
      chat: "നമസ്കാരം! ഞാൻ {org}-ന്റെ AI അസിസ്റ്റന്റാണ്. ഞാൻ നിങ്ങളെ എങ്ങനെ സഹായിക്കട്ടെ?",
      aiCall: "നമസ്കാരം{name}, ഞാൻ {org}-ന്റെ ഭാഗത്തുനിന്ന് വിളിക്കുന്ന AI അസിസ്റ്റന്റാണ്.",
    },
  },
  {
    code: "mr-IN", name: "Marathi", native: "मराठी", script: "Devanagari",
    voices: { female: "Google.mr-IN-Standard-A", male: "Google.mr-IN-Standard-B" },
    keywords: ["marathi", "मराठी"],
    menu: "मराठीसाठी {n} दाबा.",
    greeting: "नमस्कार! {org} ला कॉल केल्याबद्दल धन्यवाद. मी तुमची काय मदत करू शकते?",
    phrases: {
      retry: "माफ करा, मला नीट ऐकू आलं नाही. कृपया पुन्हा सांगाल का?",
      noInput: "मला काहीच ऐकू येत नाही, म्हणून मी कॉल बंद करत आहे. कृपया पुन्हा कॉल करा. धन्यवाद.",
      connecting: "एक क्षण थांबा, मी तुम्हाला आमच्या टीमशी जोडत आहे.",
      chosen: "नक्की, आता आपण मराठीत बोलूया.",
      chat: "नमस्कार! मी {org} ची AI सहाय्यक आहे. मी तुमची काय मदत करू शकते?",
      aiCall: "नमस्कार{name}, मी {org} कडून बोलणारी AI सहाय्यक आहे.",
    },
  },
  {
    code: "bn-IN", name: "Bengali", native: "বাংলা", script: "Bengali",
    voices: { female: "Google.bn-IN-Standard-A", male: "Google.bn-IN-Standard-B" },
    keywords: ["bengali", "bangla", "বাংলা"],
    menu: "বাংলার জন্য {n} টিপুন।",
    greeting: "নমস্কার! {org}-এ ফোন করার জন্য ধন্যবাদ। আমি আপনাকে কীভাবে সাহায্য করতে পারি?",
    phrases: {
      retry: "দুঃখিত, আমি ঠিকমতো শুনতে পাইনি। আবার বলবেন?",
      noInput: "আমি কিছু শুনতে পাচ্ছি না, তাই কলটি রাখছি। অনুগ্রহ করে আবার ফোন করবেন। ধন্যবাদ।",
      connecting: "এক মুহূর্ত, আমি আপনাকে আমাদের টিমের সাথে যুক্ত করছি।",
      chosen: "ঠিক আছে, এখন আমরা বাংলায় কথা বলি।",
      chat: "নমস্কার! আমি {org}-এর AI সহকারী। আমি আপনাকে কীভাবে সাহায্য করতে পারি?",
      aiCall: "নমস্কার{name}, আমি {org}-এর পক্ষ থেকে ফোন করছি। আমি একজন AI সহকারী।",
    },
  },
  {
    code: "gu-IN", name: "Gujarati", native: "ગુજરાતી", script: "Gujarati",
    voices: { female: "Google.gu-IN-Standard-A", male: "Google.gu-IN-Standard-B" },
    keywords: ["gujarati", "ગુજરાતી"],
    menu: "ગુજરાતી માટે {n} દબાવો.",
    greeting: "નમસ્તે! {org}ને કૉલ કરવા બદલ આભાર. હું આપની શું મદદ કરી શકું?",
    phrases: {
      retry: "માફ કરશો, મને બરાબર સંભળાયું નહીં. ફરીથી કહેશો?",
      noInput: "મને કંઈ સંભળાતું નથી, એટલે હું કૉલ પૂરો કરું છું. કૃપા કરીને ફરી કૉલ કરજો. આભાર.",
      connecting: "એક ક્ષણ, હું તમને અમારી ટીમ સાથે જોડું છું.",
      chosen: "ચોક્કસ, હવે આપણે ગુજરાતીમાં વાત કરીએ.",
      chat: "નમસ્તે! હું {org}ની AI સહાયક છું. હું આપની શું મદદ કરી શકું?",
      aiCall: "નમસ્તે{name}, હું {org} તરફથી વાત કરતી AI સહાયક છું.",
    },
  },
  {
    code: "en-US", name: "English (US)", native: "English (US)", script: "Latin",
    voices: { female: "Google.en-US-Neural2-F", male: "Google.en-US-Neural2-D" },
    keywords: ["american"],
    menu: "For US English, press {n}.",
    greeting: "Hello! Thank you for calling {org}. How can I help you today?",
    phrases: {
      retry: "Sorry, I didn't catch that. Could you say it again?",
      noInput: "I can't hear anything, so I'll hang up now. Please call again. Goodbye.",
      connecting: "One moment, I'm connecting you to our team.",
      chosen: "Sure, let's continue in English.",
      chat: "Hi! I'm the AI assistant for {org}. How can I help you today?",
      aiCall: "Hello{name}, this is an AI assistant calling from {org}.",
    },
  },
];

const BY_CODE = new Map(LANGUAGE_DATA.map((l) => [l.code, l]));

export function lang(code) {
  return BY_CODE.get(code) ?? LANGUAGE_DATA[0];
}

export function isLanguage(code) {
  return BY_CODE.has(code);
}

/** The languages a receptionist speaks, main language first. */
export function agentLanguages(agent) {
  const list = [agent.language, ...(agent.languages || [])].filter(isLanguage);
  return [...new Set(list)];
}

/** Twilio voice for a language, honouring the owner's choices. */
export function voiceFor(agent, code) {
  if (agent.voices?.[code]) return agent.voices[code];
  if (code === agent.language && agent.voice) return agent.voice;
  return lang(code).voices[agent.voiceGender === "male" ? "male" : "female"];
}

/**
 * Greeting in a language: the owner's text for that language, else the main
 * greeting if it is written in that language's script (so an English
 * template greeting is never read out by a Tamil voice), else the built-in one.
 */
export function greetingIn(agent, code, orgName) {
  if (agent.greetings?.[code]) return agent.greetings[code];
  if (code === agent.language && agent.greeting && scriptOf(agent.greeting) === lang(code).script) return agent.greeting;
  return lang(code).greeting.replace("{org}", orgName || agent.name);
}

/** The main script of a text: "Latin", "Devanagari", "Tamil"... */
export function scriptOf(text) {
  const letters = String(text).replace(/[\s\d\p{P}\p{S}]/gu, "");
  for (const [script, re] of SCRIPTS) {
    if ((letters.match(re) || []).length / (letters.length || 1) >= 0.5) return script;
  }
  return "Latin";
}

export function phrase(code, key, vars = {}) {
  return lang(code).phrases[key].replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
}

/** "For English, press 1." for each language in the menu, in its own words. */
export function menuLines(agent) {
  return agentLanguages(agent).map((code, i) => ({ code, text: lang(code).menu.replace("{n}", String(i + 1)) }));
}

/** Which language did the caller pick? Accepts a key press or a spoken name. */
export function pickLanguage(agent, { digits, speech }) {
  const langs = agentLanguages(agent);
  if (digits && /^\d$/.test(digits)) return langs[Number(digits) - 1] ?? null;
  const said = String(speech || "").toLowerCase();
  if (!said) return null;
  return langs.find((code) => lang(code).keywords.some((k) => said.includes(k.toLowerCase()))) ?? null;
}

// Unicode blocks of Indian scripts, to notice when a caller (or chat visitor)
// writes or is transcribed in another language.
const SCRIPTS = [
  ["Devanagari", /[ऀ-ॿ]/g],
  ["Bengali", /[ঀ-৿]/g],
  ["Gujarati", /[઀-૿]/g],
  ["Tamil", /[஀-௿]/g],
  ["Telugu", /[ఀ-౿]/g],
  ["Kannada", /[ಀ-೿]/g],
  ["Malayalam", /[ഀ-ൿ]/g],
];

/**
 * If the text is mostly in one Indian script that one of the receptionist's
 * languages uses (and the current language doesn't), return that language.
 */
export function detectLanguage(agent, text, current) {
  const letters = String(text).replace(/[\s\d\p{P}]/gu, "").length;
  if (!letters) return null;
  for (const [script, re] of SCRIPTS) {
    const count = (String(text).match(re) || []).length;
    if (count / letters < 0.5) continue;
    if (lang(current).script === script) return null; // already speaking a language in this script
    return agentLanguages(agent).find((code) => lang(code).script === script) ?? null;
  }
  return null;
}

/** Speaking speed, applied with SSML <prosody>. */
export const RATES = { slow: "85%", normal: null, fast: "112%" };

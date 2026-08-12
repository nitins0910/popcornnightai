/* =========================================================
   POPCORNNIGHT — MOVIE MOOD MATCHER
   ========================================================= */

// -----------------------------------------------------------
// 1. TMDB CONFIG
// -----------------------------------------------------------
const TMDB_API_KEY = "384b88cd6b95e74c151f88fc28ebb9a5";
const TMDB_BASE_URL = "https://tmdb-proxy.nitins1009.workers.dev/3";
const TMDB_IMG_URL = "https://image.tmdb.org/t/p/w500";
const TMDB_BACKDROP_URL = "https://image.tmdb.org/t/p/w780";
const TMDB_LOGO_URL = "https://image.tmdb.org/t/p/w92";
const PLACEHOLDER_POSTER =
    "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='170'%3E%3Crect width='100%25' height='100%25' fill='%23150c10'/%3E%3Ctext x='50%25' y='50%25' fill='%23cbb9a8' font-size='14' text-anchor='middle' dy='.3em'%3ENo Poster%3C/text%3E%3C/svg%3E";

const FALLBACK_POSTERS = [
    "/q6y0Go1tsGEsmtFryDOJo3dEmqu.jpg",
    "/3bhkrjOiHueA031P2LODq3P4S22.jpg",
    "/pB81P8LJWE0StM32AR3P3R383.jpg",
    "/8Gxv8gSFCU0XGDykEGv3B3j.jpg",
    "/gEU2QniE6E77NI6lCU6MxlNBvIx.jpg"
];

const TMDB_LANG_MAP = { en: "en-US", hi: "hi-IN" };

// -----------------------------------------------------------
// 1b. GEMINI CONFIG (AI-driven quiz)
// -----------------------------------------------------------
// 👉 Paste your free Gemini API key here (get one at https://aistudio.google.com/apikey)
// Note: Google now issues two key formats:
//  - "Standard" keys (start with AIzaSy...) — work as a ?key= query param.
//  - "Auth" keys (start with AQ.) — issued by default since June 2026, must
//    be sent as the x-goog-api-key HEADER (some accounts also see these
//    Auth keys come back with 0 quota due to Google-side account review —
//    if that happens, a working Standard key from an older project, like
//    the one you're using now, is a valid workaround).
// We send the key BOTH ways below so either format works without editing this file.
const GEMINI_API_KEY = "AQ.Ab8RN6J0CS4eQ5SIefR7QSQRku0EjnPAthTi_2o6y5CpOPZ6zw";
const GEMINI_MODEL = "gemini-3.5-flash-lite";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
const AI_TYPICAL_QUESTIONS = 5;
const AI_MAX_QUESTIONS = 8;
const AI_FETCH_TIMEOUT_MS = 20000;

// -----------------------------------------------------------
// 1c. GOOGLE SIGN-IN CONFIG (full-page redirect flow — no popup, no FedCM)
// -----------------------------------------------------------
// 👉 Create an OAuth Client ID (type "Web application") at
//    https://console.cloud.google.com/apis/credentials — then, IMPORTANT:
//    add this site's exact URL under BOTH
//      - "Authorized JavaScript origins"  (e.g. https://yoursite.com)
//      - "Authorized redirect URIs"       (e.g. https://yoursite.com/index.html
//         or wherever this page is served from — must match exactly,
//         including http vs https and trailing slash/filename)
//    Without a real Client ID, sign-in will show a friendly error instead
//    of crashing the rest of the app.
const GOOGLE_CLIENT_ID = "841276363055-ju5n6mugao7mjcosakr5efjocsird0gq.apps.googleusercontent.com";
const GOOGLE_OAUTH_SCOPE = "openid email profile";
const GOOGLE_STATE_KEY = "popcornnight_oauth_state";
const USER_SESSION_KEY = "popcornnight_user";
let currentUser = null; // { sub, name, email, picture }

// -----------------------------------------------------------
// 1d. WISHLIST CONFIG
// -----------------------------------------------------------
// Wishlist data is namespaced per Google account (by "sub") and stored in
// this browser's localStorage — it will follow the user across sessions on
// THIS device/browser. True cross-device sync would need a real backend
// (e.g. Firebase/Supabase) wired to the same Google Client ID above.
function wishlistStorageKey() {
    return currentUser ? `popcornnight_wishlist_${currentUser.sub}` : null;
}

// Same idea as the wishlist: the "Continue with X" resume chip must be
// namespaced per signed-in Google account (or a shared "guest" bucket when
// signed out), otherwise switching accounts on the same device/browser
// would keep showing the previous account's last-viewed movie.
function lastMovieStorageKey() {
    return `popcornnight_last_movie_${currentUser ? currentUser.sub : "guest"}`;
}

// Calls the Gemini API with a plain-text prompt and returns the parsed JSON
// object the model was instructed to reply with. Throws on any failure so
// callers can show a friendly error state.
async function callGemini(promptText) {
    if (!GEMINI_API_KEY || GEMINI_API_KEY === "YOUR_GEMINI_API_KEY_HERE") {
        throw new Error("no-gemini-key");
    }

    const res = await fetchWithTimeout(GEMINI_URL, AI_FETCH_TIMEOUT_MS, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": GEMINI_API_KEY
        },
        body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: promptText }] }],
            generationConfig: {
                temperature: 1,
                responseMimeType: "application/json"
            }
        })
    });

    if (!res.ok) {
        let detail = "";
        try {
            const errBody = await res.json();
            detail = errBody?.error?.message || "";
        } catch (e) {}
        throw new Error(`gemini-http-${res.status}${detail ? `: ${detail}` : ""}`);
    }
    const data = await res.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) throw new Error("gemini-empty-response");

    try {
        return JSON.parse(raw);
    } catch (e) {
        // Some responses can arrive wrapped in ```json fences despite the
        // JSON mime type request — strip those before giving up.
        const cleaned = raw.replace(/```json|```/g, "").trim();
        return JSON.parse(cleaned);
    }
}

// Calls Gemini with a plain-text prompt and returns the raw text reply
// (no JSON parsing) — used for free-form chat answers and spoken movie
// explanations, as opposed to callGemini() above which forces strict JSON.
async function callGeminiText(promptText) {
    if (!GEMINI_API_KEY || GEMINI_API_KEY === "YOUR_GEMINI_API_KEY_HERE") {
        throw new Error("no-gemini-key");
    }

    const res = await fetchWithTimeout(GEMINI_URL, AI_FETCH_TIMEOUT_MS, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": GEMINI_API_KEY
        },
        body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: promptText }] }],
            generationConfig: { temperature: 0.9 }
        })
    });

    if (!res.ok) {
        let detail = "";
        try {
            const errBody = await res.json();
            detail = errBody?.error?.message || "";
        } catch (e) {}
        throw new Error(`gemini-http-${res.status}${detail ? `: ${detail}` : ""}`);
    }
    const data = await res.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) throw new Error("gemini-empty-response");
    return raw.trim();
}

// Builds the running prompt sent to Gemini on every turn of the AI quiz.
// The entire conversation so far is embedded as plain text so the model
// always has full context, and the model is told to reply with strict JSON
// so we can render it directly.
function buildAiPrompt() {
    const langLabel = currentLang === "hi" ? "Hindi, written in the Devanagari script (हिंदी)" : "English";
    const historyText = state.aiHistory
        .map((h, i) => `Q${i + 1}: ${h.question}\nUser answered: ${h.answer}`)
        .join("\n");

    const ottNames = (typeof getSelectedOtt === "function" ? getSelectedOtt() : [])
        .map((id) => (OTT_PROVIDERS.find((p) => p.id === id) || {}).name)
        .filter(Boolean);
    const ottLine = ottNames.length
        ? `\n\nThe user has told the app they subscribe to: ${ottNames.join(", ")}. Where reasonable, lean slightly toward movies likely available on these services, but never sacrifice a genuinely great match just to fit this.`
        : "";

    return `You are "Reel", a fun, witty movie-recommendation quizmaster inside a movie app called PopcornNight.${ottLine}

Ask the user short, engaging questions, one at a time, to figure out what movie they should watch tonight. Usually ${AI_TYPICAL_QUESTIONS} questions is enough, but if their answers are vague, contradictory, or you genuinely need more detail to nail a great pick, you may ask up to ${AI_MAX_QUESTIONS} questions total — never more than that. Across the questions, try to naturally cover: which film industry they're in the mood for (Hollywood / Bollywood / South Indian / no preference), genre, era/decade, what mood or feeling they want (laugh, cry, thrill, relax, scare, etc.), and anything they'd like to avoid. Keep the tone casual and fun, like a friend hyping them up for movie night.

Note: the user can also skip your suggested options and type their own free-text answer instead — treat any answer, whether it matches one of your options or not, as valid input.

Reply with ONLY strict JSON (no markdown, no commentary, no code fences) matching EXACTLY one of these two shapes:

1. To ask the next question:
{"type":"question","question":"<short fun question, one sentence>","options":["<opt1>","<opt2>","<opt3>","<opt4>"]}
- 3 to 5 short options, a few words each, a fitting emoji is welcome.

2. Once you have enough answers (at most ${AI_MAX_QUESTIONS} questions total) and are confident, give the final picks instead of another question:
{"type":"recommendation","movies":[{"title":"<exact real movie title>","year":<release year as a number>,"reason":"<one short, punchy sentence on why it fits their answers>"}]}
- Include EXACTLY 6 real, existing movies, ordered best match first.
- Never invent a movie — only recommend titles you're confident actually exist.

IMPORTANT — reply language: write EVERY piece of text in your JSON (the "question", every string in "options", and every "reason") entirely in ${langLabel}. Do not mix in English if ${langLabel} is Hindi.

Conversation so far:
${historyText || "(nothing yet — this is the very first question)"}

Now give your next response as pure JSON only.`;
}

const INDUSTRY_CONFIG = {
    hollywood: { language: "en", minVotes: 150 },
    bollywood: { language: "hi", minVotes: 20 },
    south_indian: { minVotes: 8 }
};

const SOUTH_LANG_MAP = { telugu: "te", tamil: "ta", kannada: "kn", malayalam: "ml" };
const SOUTH_ANY_LANGS = ["te", "ta", "kn", "ml"];
const ALL_INDUSTRIES = ["hollywood", "bollywood", "south_indian"];

// Curated country list (ISO 3166-1 codes accepted by TMDB's `region` param)
// used for manual location entry when browser geolocation isn't available.
const COUNTRY_LIST = [
    { code: "IN", name: "India" },
    { code: "US", name: "United States" },
    { code: "GB", name: "United Kingdom" },
    { code: "CA", name: "Canada" },
    { code: "AU", name: "Australia" },
    { code: "AE", name: "United Arab Emirates" },
    { code: "SG", name: "Singapore" },
    { code: "MY", name: "Malaysia" },
    { code: "NZ", name: "New Zealand" },
    { code: "IE", name: "Ireland" },
    { code: "DE", name: "Germany" },
    { code: "FR", name: "France" },
    { code: "ES", name: "Spain" },
    { code: "IT", name: "Italy" },
    { code: "NL", name: "Netherlands" },
    { code: "PT", name: "Portugal" },
    { code: "BR", name: "Brazil" },
    { code: "MX", name: "Mexico" },
    { code: "AR", name: "Argentina" },
    { code: "ZA", name: "South Africa" },
    { code: "NG", name: "Nigeria" },
    { code: "KE", name: "Kenya" },
    { code: "EG", name: "Egypt" },
    { code: "SA", name: "Saudi Arabia" },
    { code: "QA", name: "Qatar" },
    { code: "KW", name: "Kuwait" },
    { code: "PK", name: "Pakistan" },
    { code: "BD", name: "Bangladesh" },
    { code: "LK", name: "Sri Lanka" },
    { code: "NP", name: "Nepal" },
    { code: "JP", name: "Japan" },
    { code: "KR", name: "South Korea" },
    { code: "CN", name: "China" },
    { code: "HK", name: "Hong Kong" },
    { code: "TH", name: "Thailand" },
    { code: "ID", name: "Indonesia" },
    { code: "PH", name: "Philippines" },
    { code: "VN", name: "Vietnam" },
    { code: "RU", name: "Russia" },
    { code: "TR", name: "Turkey" },
    { code: "PL", name: "Poland" },
    { code: "SE", name: "Sweden" },
    { code: "NO", name: "Norway" },
    { code: "DK", name: "Denmark" },
    { code: "FI", name: "Finland" },
    { code: "CH", name: "Switzerland" },
    { code: "AT", name: "Austria" },
    { code: "BE", name: "Belgium" }
];

const TIMEFRAME_RANGES = {
    "70s": { gte: "1970-01-01", lte: "1979-12-31" },
    "80s": { gte: "1980-01-01", lte: "1989-12-31" },
    "90s": { gte: "1990-01-01", lte: "1999-12-31" },
    "2000s": { gte: "2000-01-01", lte: "2010-12-31" },
    "2011_2020": { gte: "2011-01-01", lte: "2020-12-31" },
    "2021_present": { gte: "2021-01-01", lte: new Date().toISOString().slice(0, 10) }
};

const GENRE_META = {
    28: { icon: "🔥", en: "Action", hi: "एक्शन" },
    12: { icon: "⚔️", en: "Adventure", hi: "एडवेंचर" },
    16: { icon: "🎨", en: "Animation", hi: "एनिमेशन" },
    35: { icon: "😂", en: "Comedy", hi: "कॉमेडी" },
    80: { icon: "🎬", en: "Crime", hi: "क्राइम" },
    99: { icon: "🎥", en: "Documentary", hi: "डॉक्यूमेंट्री" },
    18: { icon: "🎭", en: "Drama", hi: "ड्रामा" },
    10751: { icon: "👨‍👩‍👧", en: "Family", hi: "फैमिली" },
    14: { icon: "🪄", en: "Fantasy", hi: "फैंटेसी" },
    36: { icon: "📜", en: "History", hi: "इतिहास" },
    27: { icon: "👻", en: "Horror", hi: "हॉरर" },
    10402: { icon: "🎵", en: "Music", hi: "म्यूज़िक" },
    9648: { icon: "🧠", en: "Mystery", hi: "मिस्ट्री" },
    10749: { icon: "❤️", en: "Romance", hi: "रोमांस" },
    878: { icon: "🚀", en: "Sci-Fi", hi: "साइ-फाई" },
    53: { icon: "🕵️", en: "Thriller", hi: "थ्रिलर" },
    10752: { icon: "🎖️", en: "War", hi: "युद्ध" },
    37: { icon: "🤠", en: "Western", hi: "वेस्टर्न" }
};

function genreLabel(id) {
    const meta = GENRE_META[id];
    if (!meta) return null;
    return { icon: meta.icon, label: currentLang === "hi" ? meta.hi : meta.en };
}

// -----------------------------------------------------------
// 2. TRANSLATIONS
// -----------------------------------------------------------
const TRANSLATIONS = {
    en: {
        app_title: "🎬 What's The Move Tonight?",
        app_subtitle: "Bored? Vibing? Emotionally unstable? 😭 Answer a few questions and let us cook your perfect movie pick.",
        app_eyebrow: "🎬 Now Screening",
        start_btn: "Let's Cook 🔥",
        random_btn: "Random Drop 🎲",
        back_btn: "← Back",
        continue_btn: "Bet, Continue →",
        question_counter: "Question {n} of {total}",
        gift_wrapping: "🎬 Clapperboard's rolling...",
        next_movie_btn: "Skip to next",
        swipe_hint: "👈 Swipe the poster left or right for another pick",
        broaden_btn: "Widen The Net 🕸️",
        share_btn: "Share",
        share_copied: "Link copied, go flex it! 🔗",
        trailer_btn: "▶ Watch Trailer",
        youtube_free_btn: "🎬 Find Free on YouTube",
        free_label: "Free to watch",
        platforms_label: "Streaming on",
        streaming_none: "Not streaming anywhere rn, sadly",
        runtime_label: "{min} min",
        exhausted_msg: "Looks like you've watched your way through this mood already! 🍿 Tap 'Home' (top-left) to pick a new vibe.",
        error_no_key: "We're just missing one setup step behind the scenes — add a TMDB API key to script.js and you'll be all set.",
        error_no_gemini_key: "We're just missing one setup step behind the scenes — add a Gemini API key to script.js and you'll be all set.",
        error_request_failed: "Hmm, that didn't go through. Mind double-checking your API key and giving it another try?",
        error_no_matches: "We couldn't find a movie that fits this exact combo. Try 'Widen The Net' below, or head 'Home' to start fresh 🎬",
        error_network: "We're having trouble connecting right now. Please check your internet and try again in a moment.",
        ai_thinking: "🤖 Thinking of a good question...",
        retry_btn: "Try Again",
        custom_answer_placeholder: "Or type your own answer...",
        custom_answer_btn: "Submit ✓",
        select_up_to_2: "Pick up to 2 — or hit Surprise Me",
        select_any: "Select all that apply",
        search_placeholder: "Search movies...",
        no_results: "No movies matched that search — try a different title or spelling.",
        browse_error: "We couldn't load these movies right now. Please try again in a bit.",
        browse_loading: "Rounding up the picks…",
        trending_heading: "🔥 Trending Now",
        theaters_heading: "🎟️ In Theaters",
        upcoming_heading: "📅 Coming Soon",
        browse_back: "← Back",
        detecting_location: "📍 Detecting your location…",
        location_modal_title: "Set Your Location",
        location_modal_desc: "We couldn't detect your location automatically. Pick your country to see what's playing near you.",
        location_select_default: "Select your country",
        location_confirm_btn: "Show Theaters 🎟️",
        location_retry_btn: "📍 Try automatic detection again",
        location_change_btn: "Change Location",
        trailer_fallback_link: "Having trouble playing it? ▶ Watch on YouTube",

        q1_text: "What kind of cinema are you in the mood for?",
        q1_hollywood: "🇺🇸 Hollywood",
        q1_bollywood: "🇮🇳 Bollywood",
        q1_south: "🎞️ South Indian",
        q1_surprise: "🌎 No Preference — Surprise Me",
        q1b_text: "Which South Indian language?",
        q1b_telugu: "Telugu",
        q1b_tamil: "Tamil",
        q1b_malayalam: "Malayalam",
        q1b_kannada: "Kannada",
        q1b_any: "🎲 Surprise Me",
        q2_text: "What genre are you feeling right now?",
        q2_romance: "❤️ Romance",
        q2_comedy: "😂 Comedy",
        q2_action: "🔥 Action",
        q2_thriller: "🕵️ Thriller",
        q2_horror: "👻 Horror",
        q2_mystery: "🧠 Mystery",
        q2_drama: "🎭 Drama",
        q2_fantasy: "🪄 Fantasy",
        q2_scifi: "🚀 Sci-Fi",
        q2_family: "👨‍👩‍👧 Family",
        q2_adventure: "⚔️ Adventure",
        q2_crime: "🎬 Crime",
        q2_surprise: "🎭 I Don't Mind — Surprise Me",
        q3_text: "Which era would you like to travel to?",
        q3_70s: "📼 1970s",
        q3_80s: "📺 1980s",
        q3_90s: "🎞️ 1990s",
        q3_2000s: "💿 2000–2010",
        q3_2011_2020: "📱 2011–2020",
        q3_2021_present: "✨ 2021–Present",
        q3_surprise: "🎲 Any Era — Surprise Me",
        q4_text: "What do you want this movie to do for you?",
        q4_laugh: "😂 Make me laugh",
        q4_feel: "❤️ Make me feel something",
        q4_relax: "🧘 Help me relax",
        q4_adrenaline: "🔥 Get my adrenaline going",
        q4_think: "🧠 Make me think",
        q4_scare: "😱 Give me a good scare",
        q4_emotional: "🥹 Make me emotional",
        q4_motivate: "💪 Motivate / Inspire me",
        q4_guessing: "🕵️ Keep me guessing",
        q4_otherworld: "✨ Take me to another world",
        q7_text: "One last thing — what are you NOT in the mood for?",
        q7_slow: "🐌 Slow movies",
        q7_sad: "😢 Sad endings",
        q7_scary: "😱 Too scary",
        q7_violent: "🩸 Too violent",
        q7_romance: "❤️ Too much romance",
        q7_complicated: "🧠 Too complicated",
        q7_silly: "🤡 Too silly",
        q7_emotional: "😭 Too emotional",
        q7_nothing: "🚫 Nothing — I'm open to anything!",

        chat_title: "Ask about",
        chat_greeting: "Hey! 👋 I'm Reel, ask me anything about \"{title}\" — plot, cast, ending, whatever you're curious about.",
        chat_placeholder: "Ask anything about this movie...",
        chat_thinking: "Reel is typing...",
        chat_error: "Hmm, couldn't get an answer just now. Please try again.",
        explain_btn: "Explain",
        explain_loading: "Preparing...",
        explain_speaking: "Stop",
        explain_error: "Couldn't generate the explanation. Please try again.",

        wishlist_heading: "💖 My Wishlist",
        wishlist_signin_required: "Sign in with Google to save and view your wishlist.",
        wishlist_empty: "Your wishlist is empty. Tap the 💖 on any movie to save it here.",
        wishlist_saved_toast: "Saved to your wishlist 💖",
        wishlist_removed_toast: "Removed from wishlist",
        sign_in_btn: "Sign In",
        sign_out_btn: "🚪 Sign Out",
        my_wishlist_btn: "💖 My Wishlist",
        greeting_morning: "Good morning ☀️ Ready for a great pick?",
        greeting_afternoon: "Lazy afternoon? 🍿 Let's find something good.",
        greeting_evening: "Good evening 🌙 What's the move tonight?",
        greeting_night: "Up late? 🌌 Let's find your next watch.",
        resume_chip_label: "Continue with",
        chip_trending: "🔥 Trending",
        chip_theaters: "🎟️ In Theaters",
        chip_upcoming: "📅 Coming Soon",
        chip_wishlist: "💖 Wishlist",
        home_trending_heading: "🔥 Trending Right Now",
        settings_title: "⚙️ Settings",
        settings_language_label: "Language",
        chip_watchparty: "🎉 Watch Party",
        settings_notif_label: "Notifications",
        mood_placeholder: "I feel like something slow and heartbreaking...",
        mood_submit_btn: "Find it →",
        mood_error: "Couldn't quite place that mood — try describing it a bit differently.",
        recent_heading: "🕓 Recently Viewed",
        ott_heading: "📺 What do you have?",
        spoiler_toggle_label: "Spoiler-safe",
        explain_loading_eli5: "Preparing (simple)...",
        explain_loading_critic: "Preparing (critic)...",
        compare_desc: "Currently viewing:",
        compare_placeholder: "What should I compare it with? e.g. Interstellar",
        compare_btn: "Compare 🎬",
        watchparty_desc: "Answer a few quick taste questions each, and we'll merge both picks into one recommendation. Perfect for movie night with a friend — pass the device back and forth.",
        watchparty_room_label: "Room Code",
        watchparty_copy_btn: "Copy Link",
        watchparty_continue_btn: "Continue →",
        watchparty_player_a: "Player 1's turn",
        watchparty_player_b: "Player 2's turn",
        watchparty_finding: "Finding a movie you'll both like...",
        ticket_affiliate_btn: "🎟️ Book Tickets",
        notif_enabled_toast: "Notifications on 🔔",
        offline_toast: "You're offline — showing cached content where possible.",
        why_youll_like_prefix: "💡 Because you liked"
    },
    hi: {
        app_title: "🎬 आज रात देखना क्या है?",
        app_subtitle: "बोर हो रहे हो? वाइब में हो? इमोशनल हो गए? 😭 कुछ सवालों के जवाब दो, हम तुम्हारी परफेक्ट फिल्म ढूंढ देंगे।",
        app_eyebrow: "🎬 अभी चल रही है",
        start_btn: "चलो शुरू करते हैं 🔥",
        random_btn: "रैंडम ड्रॉप 🎲",
        back_btn: "← पीछे",
        continue_btn: "आगे बढ़ें →",
        question_counter: "प्रश्न {n} / {total}",
        gift_wrapping: "🎬 क्लैपरबोर्ड चल रहा है...",
        next_movie_btn: "अगली पर जाएं",
        swipe_hint: "👈 अगली पिक के लिए पोस्टर स्वाइप करें",
        broaden_btn: "दायरा बढ़ाएं 🕸️",
        share_btn: "शेयर करें",
        share_copied: "लिंक कॉपी हो गया, फ्लेक्स करो! 🔗",
        trailer_btn: "▶ ट्रेलर देखें",
        youtube_free_btn: "🎬 YouTube पर फ्री खोजें",
        free_label: "मुफ़्त उपलब्ध",
        platforms_label: "यहाँ स्ट्रीम करें",
        streaming_none: "फिलहाल कहीं भी स्ट्रीमिंग पर उपलब्ध नहीं",
        runtime_label: "{min} मिनट",
        exhausted_msg: "लगता है आपने इस मूड की सारी फ़िल्में देख लीं! 🍿 नया मूड चुनने के लिए 'होम' (ऊपर-बाएं) दबाएं।",
        error_no_key: "बस एक छोटा सा सेटअप बाकी है — script.js में अपनी TMDB API key जोड़ दें, फिर सब तैयार हो जाएगा।",
        error_no_gemini_key: "बस एक छोटा सा सेटअप बाकी है — script.js में अपनी Gemini API key जोड़ दें, फिर सब तैयार हो जाएगा।",
        error_request_failed: "कुछ गड़बड़ हो गई। कृपया अपनी API key जांचें और दोबारा कोशिश करें।",
        error_no_matches: "इस चयन के लिए कोई फिल्म नहीं मिली। नीचे 'दायरा बढ़ाएं' आज़माएं, या 'होम' से नई शुरुआत करें 🎬",
        error_network: "अभी कनेक्ट करने में दिक्कत आ रही है। कृपया अपना इंटरनेट जांचें और थोड़ी देर में फिर कोशिश करें।",
        ai_thinking: "🤖 अगला सवाल सोच रहे हैं...",
        retry_btn: "फिर कोशिश करें",
        custom_answer_placeholder: "या अपना खुद का जवाब लिखें...",
        custom_answer_btn: "भेजें ✓",
        select_up_to_2: "2 तक चुनें — या सरप्राइज़ मी",
        select_any: "जो भी लागू हो, चुनें",
        search_placeholder: "फ़िल्में खोजें...",
        no_results: "इस खोज से कोई फ़िल्म नहीं मिली — कोई और नाम या स्पेलिंग आज़माएं।",
        browse_error: "अभी ये फ़िल्में लोड नहीं हो पाईं। कृपया थोड़ी देर में फिर कोशिश करें।",
        browse_loading: "फ़िल्में जुटाई जा रही हैं…",
        trending_heading: "🔥 अभी ट्रेंडिंग",
        theaters_heading: "🎟️ थिएटर में अभी",
        upcoming_heading: "📅 जल्द रिलीज़ होने वाली",
        browse_back: "← पीछे",
        detecting_location: "📍 आपकी लोकेशन पता की जा रही है…",
        location_modal_title: "अपनी लोकेशन सेट करें",
        location_modal_desc: "हम आपकी लोकेशन अपने आप पता नहीं कर पाए। अपने आस-पास चल रही फिल्में देखने के लिए अपना देश चुनें।",
        location_select_default: "अपना देश चुनें",
        location_confirm_btn: "थिएटर दिखाएं 🎟️",
        location_retry_btn: "📍 दोबारा अपने आप पता करें",
        location_change_btn: "लोकेशन बदलें",
        trailer_fallback_link: "चलने में दिक्कत हो रही है? ▶ YouTube पर देखें",

        q1_text: "आप किस तरह के सिनेमा के मूड में हैं?",
        q1_hollywood: "🇺🇸 हॉलीवुड",
        q1_bollywood: "🇮🇳 बॉलीवुड",
        q1_south: "🎞️ साउथ इंडियन",
        q1_surprise: "🌎 कोई पसंद नहीं — सरप्राइज़ मी",
        q1b_text: "कौन सी साउथ इंडियन भाषा?",
        q1b_telugu: "तेलुगु",
        q1b_tamil: "तमिल",
        q1b_malayalam: "मलयालम",
        q1b_kannada: "कन्नड़",
        q1b_any: "🎲 सरप्राइज़ मी",
        q2_text: "अभी आप किस जॉनर के मूड में हैं?",
        q2_romance: "❤️ रोमांस",
        q2_comedy: "😂 कॉमेडी",
        q2_action: "🔥 एक्शन",
        q2_thriller: "🕵️ थ्रिलर",
        q2_horror: "👻 हॉरर",
        q2_mystery: "🧠 मिस्ट्री",
        q2_drama: "🎭 ड्रामा",
        q2_fantasy: "🪄 फैंटेसी",
        q2_scifi: "🚀 साइ-फाई",
        q2_family: "👨‍👩‍👧 फैमिली",
        q2_adventure: "⚔️ एडवेंचर",
        q2_crime: "🎬 क्राइम",
        q2_surprise: "🎭 कोई फर्क नहीं — सरप्राइज़ मी",
        q3_text: "आप किस दौर की सैर करना चाहेंगे?",
        q3_70s: "📼 1970 का दशक",
        q3_80s: "📺 1980 का दशक",
        q3_90s: "🎞️ 1990 का दशक",
        q3_2000s: "💿 2000–2010",
        q3_2011_2020: "📱 2011–2020",
        q3_2021_present: "✨ 2021–अब तक",
        q3_surprise: "🎲 कोई भी दौर — सरप्राइज़ मी",
        q4_text: "आप चाहते हैं कि यह फिल्म आपके लिए क्या करे?",
        q4_laugh: "😂 मुझे हंसाए",
        q4_feel: "❤️ मुझे कुछ महसूस कराए",
        q4_relax: "🧘 मुझे रिलैक्स कराए",
        q4_adrenaline: "🔥 मेरा एड्रेनालिन बढ़ाए",
        q4_think: "🧠 मुझे सोचने पर मजबूर करे",
        q4_scare: "😱 मुझे अच्छे से डराए",
        q4_emotional: "🥹 मुझे भावुक करे",
        q4_motivate: "💪 मुझे प्रेरित करे",
        q4_guessing: "🕵️ मुझे अनुमान लगाते रखे",
        q4_otherworld: "✨ मुझे किसी और दुनिया में ले जाए",
        q7_text: "आखिरी बात — आप किस मूड में नहीं हैं?",
        q7_slow: "🐌 धीमी फिल्में",
        q7_sad: "😢 दुखद अंत",
        q7_scary: "😱 बहुत डरावनी",
        q7_violent: "🩸 बहुत हिंसक",
        q7_romance: "❤️ बहुत ज़्यादा रोमांस",
        q7_complicated: "🧠 बहुत उलझी हुई",
        q7_silly: "🤡 बहुत बचकानी",
        q7_emotional: "😭 बहुत भावुक",
        q7_nothing: "🚫 कुछ नहीं — मैं किसी के लिए भी तैयार हूँ!",

        chat_title: "इस फिल्म के बारे में पूछें",
        chat_greeting: "नमस्ते! 👋 मैं Reel हूं, \"{title}\" के बारे में जो भी पूछना है पूछ लो — कहानी, कलाकार, अंत, कुछ भी।",
        chat_placeholder: "इस मूवी के बारे में कुछ भी पूछें...",
        chat_thinking: "Reel टाइप कर रहा है...",
        chat_error: "अभी जवाब नहीं मिल पाया। कृपया फिर से कोशिश करें।",
        explain_btn: "समझाएं",
        explain_loading: "तैयार हो रहा है...",
        explain_speaking: "रोकें",
        explain_error: "समझाना नहीं बन पाया। कृपया फिर से कोशिश करें।",

        wishlist_heading: "💖 मेरी विशलिस्ट",
        wishlist_signin_required: "अपनी विशलिस्ट सेव और देखने के लिए Google से साइन इन करें।",
        wishlist_empty: "आपकी विशलिस्ट खाली है। किसी भी मूवी पर 💖 दबाकर उसे यहां सेव करें।",
        wishlist_saved_toast: "विशलिस्ट में सेव हो गया 💖",
        wishlist_removed_toast: "विशलिस्ट से हटा दिया गया",
        sign_in_btn: "साइन इन करें",
        sign_out_btn: "🚪 साइन आउट",
        my_wishlist_btn: "💖 मेरी विशलिस्ट",
        greeting_morning: "सुप्रभात ☀️ आज कुछ बढ़िया देखते हैं?",
        greeting_afternoon: "आलसी दोपहर? 🍿 कुछ अच्छा ढूंढते हैं।",
        greeting_evening: "शुभ संध्या 🌙 आज रात क्या देखें?",
        greeting_night: "देर रात जाग रहे हो? 🌌 अगली मूवी ढूंढते हैं।",
        resume_chip_label: "इसे जारी रखें",
        chip_trending: "🔥 ट्रेंडिंग",
        chip_theaters: "🎟️ थिएटर में",
        chip_upcoming: "📅 जल्द आ रही",
        chip_wishlist: "💖 विशलिस्ट",
        home_trending_heading: "🔥 अभी ट्रेंडिंग में",
        settings_title: "⚙️ सेटिंग्स",
        settings_language_label: "भाषा",
        chip_watchparty: "🎉 वॉच पार्टी",
        settings_notif_label: "नोटिफिकेशन",
        mood_placeholder: "मुझे कुछ धीमा और भावुक देखना है...",
        mood_submit_btn: "ढूंढो →",
        mood_error: "यह मूड समझ नहीं आया — थोड़ा अलग तरीके से बताएं।",
        recent_heading: "🕓 हाल ही में देखा",
        ott_heading: "📺 आपके पास क्या है?",
        spoiler_toggle_label: "स्पॉइलर-सेफ",
        explain_loading_eli5: "तैयार हो रहा है (सरल)...",
        explain_loading_critic: "तैयार हो रहा है (समीक्षक)...",
        compare_desc: "अभी देख रहे हैं:",
        compare_placeholder: "किससे तुलना करें? जैसे Interstellar",
        compare_btn: "तुलना करें 🎬",
        watchparty_desc: "दोनों कुछ सवालों के जवाब दें, हम दोनों की पसंद मिलाकर एक फिल्म सुझाएंगे।",
        watchparty_room_label: "रूम कोड",
        watchparty_copy_btn: "लिंक कॉपी करें",
        watchparty_continue_btn: "आगे बढ़ें →",
        watchparty_player_a: "खिलाड़ी 1 की बारी",
        watchparty_player_b: "खिलाड़ी 2 की बारी",
        watchparty_finding: "आप दोनों के लिए फिल्म ढूंढ रहे हैं...",
        ticket_affiliate_btn: "🎟️ टिकट बुक करें",
        notif_enabled_toast: "नोटिफिकेशन चालू 🔔",
        offline_toast: "आप ऑफलाइन हैं — जो उपलब्ध है वो दिखा रहे हैं।",
        why_youll_like_prefix: "💡 क्योंकि आपको पसंद आई"
    }
};

let currentLang = "en";

function t(key, vars) {
    const dict = TRANSLATIONS[currentLang] || TRANSLATIONS.en;
    let str = dict[key] || TRANSLATIONS.en[key] || key;
    if (vars) {
        Object.keys(vars).forEach((k) => {
            str = str.replace(`{${k}}`, vars[k]);
        });
    }
    return str;
}

// -----------------------------------------------------------
// 3. LEGACY 5-STEP QUESTION TREE (kept for reference, no longer used —
//    the quiz is now driven live by Gemini, see "GEMINI CONFIG" above)
// -----------------------------------------------------------
const QUESTIONS = {
    q1_industry: {
        type: "single",
        textKey: "q1_text",
        options: [
            { labelKey: "q1_hollywood", value: "hollywood" },
            { labelKey: "q1_bollywood", value: "bollywood" },
            { labelKey: "q1_south", value: "south_indian" },
            { labelKey: "q1_surprise", value: "surprise" }
        ],
        next: (value) => (value === "south_indian" ? "q1b_south_lang" : "q2_genre")
    },
    q1b_south_lang: {
        type: "single",
        textKey: "q1b_text",
        options: [
            { labelKey: "q1b_telugu", value: "telugu" },
            { labelKey: "q1b_tamil", value: "tamil" },
            { labelKey: "q1b_malayalam", value: "malayalam" },
            { labelKey: "q1b_kannada", value: "kannada" },
            { labelKey: "q1b_any", value: "any" }
        ],
        next: () => "q2_genre"
    },
    q2_genre: {
        type: "multi",
        maxSelect: 2,
        exclusiveValue: "surprise",
        hintKey: "select_up_to_2",
        textKey: "q2_text",
        options: [
            { labelKey: "q2_romance", value: "romance", genres: [10749] },
            { labelKey: "q2_comedy", value: "comedy", genres: [35] },
            { labelKey: "q2_action", value: "action", genres: [28] },
            { labelKey: "q2_thriller", value: "thriller", genres: [53] },
            { labelKey: "q2_horror", value: "horror", genres: [27] },
            { labelKey: "q2_mystery", value: "mystery", genres: [9648] },
            { labelKey: "q2_drama", value: "drama", genres: [18] },
            { labelKey: "q2_fantasy", value: "fantasy", genres: [14] },
            { labelKey: "q2_scifi", value: "scifi", genres: [878] },
            { labelKey: "q2_family", value: "family", genres: [10751] },
            { labelKey: "q2_adventure", value: "adventure", genres: [12] },
            { labelKey: "q2_crime", value: "crime", genres: [80] },
            { labelKey: "q2_surprise", value: "surprise", genres: [] }
        ],
        next: () => "q3_era"
    },
    q3_era: {
        type: "single",
        textKey: "q3_text",
        options: [
            { labelKey: "q3_70s", value: "70s" },
            { labelKey: "q3_80s", value: "80s" },
            { labelKey: "q3_90s", value: "90s" },
            { labelKey: "q3_2000s", value: "2000s" },
            { labelKey: "q3_2011_2020", value: "2011_2020" },
            { labelKey: "q3_2021_present", value: "2021_present" },
            { labelKey: "q3_surprise", value: "surprise" }
        ],
        next: () => "q4_purpose"
    },
    q4_purpose: {
        type: "single",
        textKey: "q4_text",
        options: [
            { labelKey: "q4_laugh", value: "laugh", genres: [35, 35], reasonKey: "reason_laugh", reasonIcon: "😂" },
            { labelKey: "q4_feel", value: "feel", genres: [18, 18], reasonKey: "reason_feel", reasonIcon: "❤️" },
            { labelKey: "q4_relax", value: "relax", genres: [10751, 10749], reasonKey: "reason_relax", reasonIcon: "🧘" },
            { labelKey: "q4_adrenaline", value: "adrenaline", genres: [28, 53], reasonKey: "reason_adrenaline", reasonIcon: "🔥" },
            { labelKey: "q4_think", value: "think", genres: [9648, 878], reasonKey: "reason_think", reasonIcon: "🧠" },
            { labelKey: "q4_scare", value: "scare", genres: [27, 27], reasonKey: "reason_scare", reasonIcon: "😱" },
            { labelKey: "q4_emotional", value: "emotional", genres: [18, 10749], reasonKey: "reason_emotional", reasonIcon: "🥹" },
            { labelKey: "q4_motivate", value: "motivate", genres: [18, 12], reasonKey: "reason_motivate", reasonIcon: "💪" },
            { labelKey: "q4_guessing", value: "guessing", genres: [9648, 53], reasonKey: "reason_guessing", reasonIcon: "🕵️" },
            { labelKey: "q4_otherworld", value: "otherworld", genres: [14, 878], reasonKey: "reason_otherworld", reasonIcon: "✨" }
        ],
        next: () => "q5_avoid"
    },
    q5_avoid: {
        type: "multi",
        maxSelect: 9,
        exclusiveValue: "nothing",
        hintKey: "select_any",
        textKey: "q7_text", 
        options: [
            { labelKey: "q7_slow", value: "slow", excludeGenres: [99, 36] },
            { labelKey: "q7_sad", value: "sad", excludeGenres: [10752] },
            { labelKey: "q7_scary", value: "scary", excludeGenres: [27] },
            { labelKey: "q7_violent", value: "violent", excludeGenres: [28, 80, 10752] },
            { labelKey: "q7_romance", value: "romance", excludeGenres: [10749] },
            { labelKey: "q7_complicated", value: "complicated", excludeGenres: [9648, 878] },
            { labelKey: "q7_silly", value: "silly", excludeGenres: [35] },
            { labelKey: "q7_emotional", value: "emotional", excludeGenres: [18] },
            { labelKey: "q7_nothing", value: "nothing", excludeGenres: [] }
        ],
        next: () => null
    }
};

// -----------------------------------------------------------
// 4. STATE
// -----------------------------------------------------------
let state = null;
let requestCache = new Map();
let lastErrorMessage = "";

function freshState() {
    return {
        currentQuestionId: "q1_industry",
        stepNumber: 1,
        totalSteps: 5,
        industry: null,
        resolvedIndustry: null,
        southLanguage: null,
        resolvedSouthLanguage: null,
        dateRange: null,
        genrePool: [],
        excludeGenres: new Set(),
        reasons: [],
        history: [],
        shownMovieIds: new Set(),
        candidates: [],
        singlePage: 1,
        singleTotalPages: 1,
        southAnyPages: { te: 1, ta: 1, kn: 1, ml: 1 },
        exhaustedPages: false,
        currentMovie: null,
        selected: [],
        isRandomMode: false,
        isAiMode: false,
        aiHistory: [],
        aiRecommendations: [],
        aiUsedTitles: new Set()
    };
}

// -----------------------------------------------------------
// 5. DOM REFERENCES
// -----------------------------------------------------------
const startScreen = document.getElementById("start-screen");
const quizScreen = document.getElementById("quiz-screen");
const revealScreen = document.getElementById("reveal-screen");

const homeBtn = document.getElementById("home-btn");
const searchToggleBtn = document.getElementById("search-toggle-btn");
const searchPanel = document.getElementById("search-panel");
const searchInput = document.getElementById("movie-search-input");
const searchResults = document.getElementById("search-results");
const searchClearBtn = document.getElementById("search-clear-btn");

const trendingBtn = document.getElementById("trending-btn");
const theatersBtn = document.getElementById("theaters-btn");
const upcomingBtn = document.getElementById("upcoming-btn");
const browseScreen = document.getElementById("browse-screen");
const browseBackBtn = document.getElementById("browse-back-btn");
const browseHeading = document.getElementById("browse-heading");
const browseTitleTag = document.getElementById("browse-title");
const browseGrid = document.getElementById("browse-grid");
const browseLoading = document.getElementById("browse-loading");
const browseError = document.getElementById("browse-error");
const locationChangeBtn = document.getElementById("location-change-btn");
const locationChangeBtnText = document.getElementById("location-change-btn-text");
const locationInfo = document.getElementById("location-info");
const locationDisplay = document.getElementById("location-display");

const locationModal = document.getElementById("location-modal");
const locationModalBackdrop = document.getElementById("location-modal-backdrop");
const locationModalClose = document.getElementById("location-modal-close");
const locationModalTitle = document.getElementById("location-modal-title");
const locationModalDesc = document.getElementById("location-modal-desc");
const locationCountrySelect = document.getElementById("location-country-select");
const locationConfirmBtn = document.getElementById("location-confirm-btn");
const locationRetryBtn = document.getElementById("location-retry-btn");

const settingsBtn = document.getElementById("settings-btn");
const settingsModal = document.getElementById("settings-modal");
const settingsModalBackdrop = document.getElementById("settings-modal-backdrop");
const settingsModalClose = document.getElementById("settings-modal-close");
const settingsModalTitle = document.getElementById("settings-modal-title");
const settingsLanguageLabel = document.getElementById("settings-language-label");

const trailerModal = document.getElementById("trailer-modal");
const trailerModalFrame = document.getElementById("trailer-modal-frame");
const trailerModalClose = document.getElementById("trailer-modal-close");
const trailerModalBackdrop = document.getElementById("trailer-modal-backdrop");
const trailerFallbackLink = document.getElementById("trailer-fallback-link");

const shareMenu = document.getElementById("share-menu");
const shareMenuBackdrop = document.getElementById("share-menu-backdrop");
const shareWhatsappBtn = document.getElementById("share-whatsapp-btn");
const shareInstagramBtn = document.getElementById("share-instagram-btn");
const shareCopyBtn = document.getElementById("share-copy-btn");

const startEyebrow = document.getElementById("start-eyebrow");
const startTitle = document.getElementById("start-title");
const startSubtitle = document.getElementById("start-subtitle");
const startBtn = document.getElementById("start-btn");
const randomBtn = document.getElementById("random-btn");
const progressBar = document.getElementById("progress-bar");
const questionCounter = document.getElementById("question-counter");
const questionText = document.getElementById("question-text");
const questionHint = document.getElementById("question-hint");
const optionsContainer = document.getElementById("options-container");
const quizFooter = document.getElementById("quiz-footer");
const backBtn = document.getElementById("back-btn");
const continueBtn = document.getElementById("continue-btn");

const revealBackdrop = document.getElementById("reveal-backdrop");
const clapperboardContainer = document.getElementById("clapperboard-container");
const clapperboardText = document.getElementById("clapperboard-text");
const movieResult = document.getElementById("movie-result");
const moviePoster = document.getElementById("movie-poster");
const moviePosterWrap = document.querySelector(".poster-wrap");
if (moviePoster && moviePosterWrap) {
    moviePoster.addEventListener("load", () => moviePosterWrap.classList.remove("is-loading-poster"));
    moviePoster.addEventListener("error", () => moviePosterWrap.classList.remove("is-loading-poster"));
}
const movieTitle = document.getElementById("movie-title");
const movieYear = document.getElementById("movie-year");
const movieRuntime = document.getElementById("movie-runtime");
const movieOverview = document.getElementById("movie-overview");
const movieRating = document.getElementById("movie-rating");
const movieGenres = document.getElementById("movie-genres");
const trailerLink = document.getElementById("trailer-link");
const youtubeFreeLink = document.getElementById("youtube-free-link");
const freeSection = document.getElementById("free-section");
const freeLabel = document.getElementById("free-label");
const freePlatforms = document.getElementById("free-platforms");
const platformsSection = document.getElementById("platforms-section");
const platformsLabel = document.getElementById("platforms-label");
const streamingPlatforms = document.getElementById("streaming-platforms");
const streamingNone = document.getElementById("streaming-none");
const movieError = document.getElementById("movie-error");
const nextMovieBtn = document.getElementById("next-movie-btn");
const swipeHint = document.getElementById("swipe-hint");
const broadenBtn = document.getElementById("broaden-btn");
const shareBtn = document.getElementById("share-btn");
const langSelect = document.getElementById("lang-select");
const shareToast = document.getElementById("share-toast");

// AI Chat + Explain UI refs
const movieExplainBtn = document.getElementById("movie-explain-btn");
const movieExplainBtnText = document.getElementById("movie-explain-btn-text");
const movieChatFab = document.getElementById("movie-chat-fab");
const movieChatModal = document.getElementById("movie-chat-modal");
const movieChatBackdrop = document.getElementById("movie-chat-backdrop");
const movieChatClose = document.getElementById("movie-chat-close");
const movieChatSubtitle = document.getElementById("movie-chat-subtitle");
const movieChatMessages = document.getElementById("movie-chat-messages");
const movieChatForm = document.getElementById("movie-chat-form");
const movieChatInput = document.getElementById("movie-chat-input");
const movieChatSend = document.getElementById("movie-chat-send");

// Google Sign-In + Wishlist UI refs
const movieWishlistBtn = document.getElementById("movie-wishlist-btn");
const googleSigninBtn = document.getElementById("google-signin-btn");
const googleSigninBtnText = document.getElementById("google-signin-btn-text");
const userMenuWrap = document.getElementById("user-menu-wrap");
const userAvatarBtn = document.getElementById("user-avatar-btn");
const userAvatarImg = document.getElementById("user-avatar-img");
const userDropdown = document.getElementById("user-dropdown");
const userDropdownName = document.getElementById("user-dropdown-name");
const userDropdownEmail = document.getElementById("user-dropdown-email");
const userDropdownWishlistBtn = document.getElementById("user-dropdown-wishlist-btn");
const userSignOutBtn = document.getElementById("user-sign-out-btn");
const wishlistBtn = document.getElementById("wishlist-btn");
const wishlistCountBadge = document.getElementById("wishlist-count-badge");

// Homescreen enhancement refs
const resumeChip = document.getElementById("resume-chip");
const resumeChipPoster = document.getElementById("resume-chip-poster");
const resumeChipTitle = document.getElementById("resume-chip-title");
const homeQuickChips = document.getElementById("home-quick-chips");
const homeTrendingSection = document.getElementById("home-trending-section");
const homeTrendingStrip = document.getElementById("home-trending-strip");
const homeTrendingHeadingEl = document.querySelector(".home-trending-heading");
const startSubtitleEl = document.getElementById("start-subtitle");

// Phase 2 enhancement refs
const cinemaModeBtn = document.getElementById("cinema-mode-btn");
const cinemaModeOverlay = document.getElementById("cinema-mode-overlay");
const moodInput = document.getElementById("mood-input");
const moodSubmitBtn = document.getElementById("mood-submit-btn");
const moodError = document.getElementById("mood-error");
const ottChipRow = document.getElementById("ott-chip-row");
const ottSelectHeading = document.getElementById("ott-select-heading");
const homeRecentSection = document.getElementById("home-recently-viewed-section");
const homeRecentStrip = document.getElementById("home-recent-strip");
const homeRecentHeadingEl = document.getElementById("home-recent-heading");
const explainWaveform = document.getElementById("explain-waveform");
const whyYoullLikeBadge = document.getElementById("why-youll-like-badge");
const ticketAffiliateLink = document.getElementById("ticket-affiliate-link");
const personaEli5Btn = document.getElementById("persona-eli5-btn");
const personaCriticBtn = document.getElementById("persona-critic-btn");
const spoilerToggleInput = document.getElementById("spoiler-toggle-input");
const spoilerToggleLabel = document.getElementById("spoiler-toggle-label");
const compareModeBtn = document.getElementById("compare-mode-btn");
const compareModal = document.getElementById("compare-modal");
const compareModalBackdrop = document.getElementById("compare-modal-backdrop");
const compareModalClose = document.getElementById("compare-modal-close");
const compareCurrentTitle = document.getElementById("compare-current-title");
const compareInput = document.getElementById("compare-input");
const compareSubmitBtn = document.getElementById("compare-submit-btn");
const movieChatMicBtn = document.getElementById("movie-chat-mic-btn");
const notifToggleInput = document.getElementById("notif-toggle-input");
const chipWatchparty = document.getElementById("chip-watchparty");
const watchpartyModal = document.getElementById("watchparty-modal");
const watchpartyModalBackdrop = document.getElementById("watchparty-modal-backdrop");
const watchpartyModalClose = document.getElementById("watchparty-modal-close");
const watchpartySetup = document.getElementById("watchparty-setup");
const watchpartyRoomCode = document.getElementById("watchparty-room-code");
const watchpartyCopyBtn = document.getElementById("watchparty-copy-btn");
const watchpartyQuestions = document.getElementById("watchparty-questions");
const watchpartyNextBtn = document.getElementById("watchparty-next-btn");
const watchpartyResult = document.getElementById("watchparty-result");

// -----------------------------------------------------------
// 5b. SOUND FX (tiny synthesized sounds — no external audio files)
// -----------------------------------------------------------
let audioCtx = null;
let soundEnabled = true;
try {
    soundEnabled = localStorage.getItem("mmm_sound") !== "off";
} catch (err) {}

function getAudioCtx() {
    if (!soundEnabled) return null;
    if (!audioCtx) {
        try {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        } catch (err) {
            return null;
        }
    }
    if (audioCtx.state === "suspended") {
        audioCtx.resume().catch(() => {});
    }
    return audioCtx;
}

function playTone({ freq = 880, duration = 0.06, type = "sine", startGain = 0.09, delay = 0 }) {
    const ctx = getAudioCtx();
    if (!ctx) return;
    try {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, ctx.currentTime + delay);
        gain.gain.setValueAtTime(startGain, ctx.currentTime + delay);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + delay + duration);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime + delay);
        osc.stop(ctx.currentTime + delay + duration + 0.02);
    } catch (err) {}
}

function playClickSound() {
    playTone({ freq: 640, duration: 0.045, type: "square", startGain: 0.05 });
}

function playClapSound() {
    const ctx = getAudioCtx();
    if (!ctx) return;
    try {
        const bufferSize = Math.floor(ctx.sampleRate * 0.15);
        const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            const decay = Math.pow(1 - i / bufferSize, 6);
            data[i] = (Math.random() * 2 - 1) * decay;
        }
        const noise = ctx.createBufferSource();
        noise.buffer = buffer;
        const filter = ctx.createBiquadFilter();
        filter.type = "bandpass";
        filter.frequency.value = 1800;
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.32, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.15);
        noise.connect(filter);
        filter.connect(gain);
        gain.connect(ctx.destination);
        noise.start();
        playTone({ freq: 170, duration: 0.09, type: "square", startGain: 0.16, delay: 0.01 });
    } catch (err) {}
}

function playSwipeSound(direction) {
    const ctx = getAudioCtx();
    if (!ctx) return;
    try {
        // Short filtered-noise "whoosh" with a pitch sweep — sweeps upward for
        // a right swipe and downward for a left swipe, so the two directions
        // feel distinct.
        const duration = 0.22;
        const bufferSize = Math.floor(ctx.sampleRate * duration);
        const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            const decay = Math.pow(1 - i / bufferSize, 2.2);
            data[i] = (Math.random() * 2 - 1) * decay;
        }
        const noise = ctx.createBufferSource();
        noise.buffer = buffer;

        const filter = ctx.createBiquadFilter();
        filter.type = "bandpass";
        filter.Q.value = 0.8;
        const rising = direction === "right";
        filter.frequency.setValueAtTime(rising ? 650 : 1500, ctx.currentTime);
        filter.frequency.exponentialRampToValueAtTime(rising ? 2400 : 500, ctx.currentTime + duration);

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.0001, ctx.currentTime);
        gain.gain.linearRampToValueAtTime(0.22, ctx.currentTime + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);

        noise.connect(filter);
        filter.connect(gain);
        gain.connect(ctx.destination);
        noise.start();
        noise.stop(ctx.currentTime + duration + 0.02);
    } catch (err) {}
}

// Delegated click-sound for any button/interactive element across the app
document.addEventListener("click", (e) => {
    const interactive = e.target.closest("button, .option-btn, .search-item, .browse-card, .share-menu-item");
    if (interactive && !interactive.disabled) {
        playClickSound();
    }
}, { capture: true });

// -----------------------------------------------------------
// 6. LANGUAGE
// -----------------------------------------------------------
function applyStaticTranslations() {
    startEyebrow.textContent = t("app_eyebrow");
    startTitle.textContent = t("app_title");
    startSubtitle.textContent = t("app_subtitle");
    startBtn.textContent = t("start_btn");
    randomBtn.textContent = t("random_btn");
    backBtn.textContent = t("back_btn");
    continueBtn.textContent = t("continue_btn");
    nextMovieBtn.setAttribute("aria-label", t("next_movie_btn"));
    nextMovieBtn.title = t("next_movie_btn");
    swipeHint.textContent = t("swipe_hint");
    broadenBtn.textContent = t("broaden_btn");
    shareBtn.setAttribute("aria-label", t("share_btn"));
    shareBtn.title = t("share_btn");
    freeLabel.textContent = t("free_label");
    platformsLabel.textContent = t("platforms_label");
    streamingNone.textContent = t("streaming_none");
    if(searchInput) searchInput.placeholder = t("search_placeholder");
    if(browseBackBtn) browseBackBtn.textContent = t("browse_back");
    if(browseLoading) browseLoading.textContent = t("browse_loading");
    if(locationChangeBtnText) locationChangeBtnText.textContent = t("location_change_btn");
    if(locationModalTitle) locationModalTitle.textContent = t("location_modal_title");
    if(locationModalDesc) locationModalDesc.textContent = t("location_modal_desc");
    if(locationConfirmBtn) locationConfirmBtn.textContent = t("location_confirm_btn");
    if(locationRetryBtn) locationRetryBtn.textContent = t("location_retry_btn");
    document.title = `${t("app_title")} 🎬`;
    if (movieExplainBtnText && !isExplainBusy) movieExplainBtnText.textContent = t("explain_btn");
    if (movieChatInput) movieChatInput.placeholder = t("chat_placeholder");
    if (googleSigninBtnText) googleSigninBtnText.textContent = t("sign_in_btn");
    if (userSignOutBtn) userSignOutBtn.textContent = t("sign_out_btn");
    if (userDropdownWishlistBtn) userDropdownWishlistBtn.textContent = t("my_wishlist_btn");
    if (settingsModalTitle) settingsModalTitle.textContent = t("settings_title");
    if (settingsLanguageLabel) settingsLanguageLabel.textContent = t("settings_language_label");
    document.querySelectorAll(".home-chip").forEach((chip) => {
        const mode = chip.dataset.mode;
        if (mode) chip.textContent = t(`chip_${mode}`);
    });
    if (homeTrendingHeadingEl) homeTrendingHeadingEl.textContent = t("home_trending_heading");
    if (resumeChip && !resumeChip.classList.contains("hidden")) {
        const resumeLabelEl = resumeChip.querySelector(".resume-chip-label");
        if (resumeLabelEl) resumeLabelEl.textContent = t("resume_chip_label");
    }
    if (startScreen && !startScreen.classList.contains("hidden")) setHomeGreeting();

    // Note: AI-generated quiz questions are asked live in whichever language
    // was current at the time, so we don't re-render them on a language
    // switch mid-quiz (that would need a fresh Gemini call) — only the
    // static screens (start, browse, etc.) re-translate instantly.
    if (!revealScreen.classList.contains("hidden") && state) {
        if (state.currentMovie && !movieResult.classList.contains("hidden")) {
            refreshCurrentMovieLanguage();
        }
    }
}

async function refreshCurrentMovieLanguage() {
    if (!state.currentMovie) return;
    try {
        const langParam = TMDB_LANG_MAP[currentLang] || "en-US";
        const url = `${TMDB_BASE_URL}/movie/${state.currentMovie.id}?api_key=${TMDB_API_KEY}&language=${langParam}`;
        const details = await cachedFetchJson(url);
        movieTitle.textContent = details.title || movieTitle.textContent;
        movieOverview.textContent = details.overview || movieOverview.textContent;
    } catch (err) {}
}

langSelect.addEventListener("change", () => {
    currentLang = langSelect.value;
    try {
        localStorage.setItem("mmm_lang", currentLang);
    } catch (err) {}
    applyStaticTranslations();
    const selectedRegion = locationCountrySelect ? locationCountrySelect.value : "";
    populateLocationSelect();
    if (locationCountrySelect && selectedRegion) {
        locationCountrySelect.value = selectedRegion;
    }
});

// -----------------------------------------------------------
// 7. SCREEN NAVIGATION
// -----------------------------------------------------------
function showScreen(screenEl) {
    [startScreen, quizScreen, revealScreen, browseScreen].forEach((el) => {
        if (el === screenEl) {
            el.classList.remove("hidden");
            el.classList.remove("fade-out");
            el.classList.add("fade-in");
        } else {
            el.classList.add("hidden");
        }
    });

    if (homeBtn) {
        if (screenEl === startScreen) {
            homeBtn.classList.add("hidden");
        } else {
            homeBtn.classList.remove("hidden");
        }
    }
}

// -----------------------------------------------------------
// 8. QUIZ RENDERING
// -----------------------------------------------------------
function startQuiz() {
    state = freshState();
    state.isAiMode = true;
    clapperboardContainer.classList.add("hidden");
    revealBackdrop.classList.remove("visible");
    revealBackdrop.style.backgroundImage = "";
    showScreen(quizScreen);
    askNextAiQuestion();
}

// Shows/hides an animated "thinking" state on the quiz screen while we
// wait on Gemini.
function setQuizLoading(isLoading) {
    if (isLoading) {
        questionHint.classList.add("hidden");
        optionsContainer.innerHTML = "";
        const thinking = document.createElement("div");
        thinking.className = "ai-thinking";
        thinking.innerHTML = `
            <div class="ai-thinking-dots"><span></span><span></span><span></span></div>
            <p class="ai-thinking-label">${t("ai_thinking")}</p>
        `;
        optionsContainer.appendChild(thinking);
        backBtn.disabled = true;
    } else {
        backBtn.disabled = false;
    }
    quizFooter.classList.add("hidden");
}

function showQuizError(message) {
    optionsContainer.innerHTML = "";
    questionHint.classList.add("hidden");

    const errorEl = document.createElement("p");
    errorEl.className = "error-message";
    errorEl.textContent = message;
    optionsContainer.appendChild(errorEl);

    const retryBtn = document.createElement("button");
    retryBtn.className = "btn secondary";
    retryBtn.textContent = t("retry_btn");
    retryBtn.addEventListener("click", () => askNextAiQuestion());
    optionsContainer.appendChild(retryBtn);
}

// Asks Gemini for the next step of the quiz: either another question, or —
// once it has enough answers — the final movie recommendations.
async function askNextAiQuestion() {
    setQuizLoading(true);
    try {
        const data = await callGemini(buildAiPrompt());

        if (data && data.type === "recommendation" && Array.isArray(data.movies) && data.movies.length) {
            state.aiRecommendations = data.movies;
            goToReveal();
            return;
        }

        if (data && data.type === "question" && data.question && Array.isArray(data.options) && data.options.length) {
            renderAiQuestion(data);
            return;
        }

        throw new Error("unexpected-response-shape");
    } catch (err) {
        setQuizLoading(false);
        console.error("PopcornNight AI error:", err);
        const message = err && err.message === "no-gemini-key" ? t("error_no_gemini_key") : t("error_network");
        showQuizError(message);
    }
}

function renderAiQuestion(question) {
    const stepNumber = state.aiHistory.length + 1;
    progressBar.style.width = `${Math.min(100, (stepNumber / AI_TYPICAL_QUESTIONS) * 100)}%`;
    questionCounter.textContent = t("question_counter", { n: stepNumber, total: AI_TYPICAL_QUESTIONS });
    questionText.textContent = question.question;
    questionHint.classList.add("hidden");
    quizFooter.classList.add("hidden");
    backBtn.classList.toggle("hidden", state.aiHistory.length === 0);
    backBtn.disabled = false;

    optionsContainer.innerHTML = "";
    question.options.forEach((label, index) => {
        const btn = document.createElement("button");
        btn.className = "option-btn";
        btn.textContent = label;

        if (index < 9) {
            const hint = document.createElement("span");
            hint.className = "key-hint";
            hint.textContent = String(index + 1);
            btn.appendChild(hint);
        }
        btn.addEventListener("click", () => handleAiAnswer(question, label));
        optionsContainer.appendChild(btn);
    });

    // Free-text row — lets the user answer in their own words instead of
    // picking one of the AI's suggested options.
    const customRow = document.createElement("div");
    customRow.className = "custom-answer-row";

    const customInput = document.createElement("input");
    customInput.type = "text";
    customInput.className = "custom-answer-input";
    customInput.placeholder = t("custom_answer_placeholder");
    customInput.autocomplete = "off";

    const customBtn = document.createElement("button");
    customBtn.type = "button";
    customBtn.className = "custom-answer-btn";
    customBtn.textContent = t("custom_answer_btn");

    function submitCustomAnswer() {
        const value = customInput.value.trim();
        if (!value) return;
        Array.from(optionsContainer.children).forEach((el) => {
            if (el.tagName === "BUTTON") el.disabled = true;
        });
        customInput.disabled = true;
        handleAiAnswer(question, value);
    }

    customBtn.addEventListener("click", submitCustomAnswer);
    customInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") submitCustomAnswer();
    });

    customRow.appendChild(customInput);
    customRow.appendChild(customBtn);
    optionsContainer.appendChild(customRow);
}

function handleAiAnswer(question, answerLabel) {
    Array.from(optionsContainer.children).forEach((b) => {
        if (b.tagName === "BUTTON") b.disabled = true;
    });
    state.aiHistory.push({ question: question.question, options: question.options, answer: answerLabel });
    askNextAiQuestion();
}

backBtn.addEventListener("click", () => {
    if (!state.isAiMode) {
        showScreen(startScreen);
        return;
    }
    if (!state.aiHistory.length) {
        showScreen(startScreen);
        return;
    }
    const prev = state.aiHistory.pop();
    renderAiQuestion({ question: prev.question, options: prev.options });
});

// -----------------------------------------------------------
// 9. RANDOM DROP CHOICE MODE
// -----------------------------------------------------------
async function startRandomDrop() {
    state = freshState();
    state.isRandomMode = true;

    showScreen(revealScreen);
    movieResult.classList.add("hidden");
    movieError.classList.add("hidden");
    broadenBtn.classList.add("hidden");

    playClapperboard();

    const minDelay = new Promise((resolve) => setTimeout(resolve, 800));
    const fetchPromise = fetchMovies({ reset: true });

    await Promise.all([fetchPromise, minDelay]);
    hideClapperboard();

    if (state.candidates.length > 0) {
        revealCurrentMovie();
    } else {
        showMovieError(t("error_no_matches"));
        broadenBtn.classList.remove("hidden");
    }
}

randomBtn.addEventListener("click", startRandomDrop);

// -----------------------------------------------------------
// 10. LIVE SEARCH LOGIC
// -----------------------------------------------------------
let searchTimeout = null;
let searchRequestId = 0;

searchToggleBtn.addEventListener("click", () => {
    searchPanel.classList.toggle("hidden");
    if (!searchPanel.classList.contains("hidden")) {
        searchInput.focus();
    }
});

document.addEventListener("click", (e) => {
    if (!e.target.closest("#search-container")) {
        searchPanel.classList.add("hidden");
    }
});

function updateClearBtnVisibility() {
    if (!searchClearBtn) return;
    searchClearBtn.classList.toggle("hidden", searchInput.value.trim().length === 0);
}

if (searchClearBtn) {
    searchClearBtn.addEventListener("click", () => {
        searchInput.value = "";
        searchResults.classList.add("hidden");
        searchResults.innerHTML = "";
        updateClearBtnVisibility();
        searchInput.focus();
    });
}

searchInput.addEventListener("input", (e) => {
    const query = e.target.value.trim();
    clearTimeout(searchTimeout);
    updateClearBtnVisibility();

    if (query.length < 2) {
        searchResults.classList.add("hidden");
        searchResults.innerHTML = "";
        return;
    }

    searchTimeout = setTimeout(() => {
        performSearch(query);
    }, 300);
});

// Matches the query anywhere in the title (not just at the start),
// e.g. typing "doom" finds "Avengers: Doomsday".
function rankBySubstring(results, query) {
    const q = query.toLowerCase();
    return results
        .map((movie) => {
            const title = (movie.title || movie.original_title || "").toLowerCase();
            const idx = title.indexOf(q);
            return { movie, idx };
        })
        .filter((entry) => entry.idx !== -1)
        .sort((a, b) => {
            // Word-start matches ("Doomsday" for "doom") rank above mid-word matches.
            const aWordStart = a.idx === 0 || /\s/.test(a.movie.title[a.idx - 1] || "");
            const bWordStart = b.idx === 0 || /\s/.test(b.movie.title[b.idx - 1] || "");
            if (aWordStart !== bWordStart) return aWordStart ? -1 : 1;
            if (a.idx !== b.idx) return a.idx - b.idx;
            return (b.movie.popularity || 0) - (a.movie.popularity || 0);
        })
        .map((entry) => entry.movie);
}

async function performSearch(query) {
    const requestId = ++searchRequestId;
    try {
        const langParam = TMDB_LANG_MAP[currentLang] || "en-US";
        const urlPage1 = `${TMDB_BASE_URL}/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}&language=${langParam}&include_adult=false&page=1`;
        const urlPage2 = `${TMDB_BASE_URL}/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}&language=${langParam}&include_adult=false&page=2`;

        const [page1, page2] = await Promise.allSettled([
            cachedFetchJson(urlPage1),
            cachedFetchJson(urlPage2)
        ]);

        if (requestId !== searchRequestId) return; // a newer keystroke superseded this request

        let merged = [];
        if (page1.status === "fulfilled") merged.push(...(page1.value.results || []));
        if (page2.status === "fulfilled") merged.push(...(page2.value.results || []));

        const seen = new Set();
        merged = merged.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));

        const ranked = rankBySubstring(merged, query);
        renderSearchResults(ranked, query);
    } catch (err) {
        console.error("Search failed", err);
    }
}

function highlightMatch(title, query) {
    const idx = title.toLowerCase().indexOf(query.toLowerCase());
    if (idx === -1) return title;
    const before = title.slice(0, idx);
    const match = title.slice(idx, idx + query.length);
    const after = title.slice(idx + query.length);
    return `${before}<span class="search-item-match">${match}</span>${after}`;
}

function renderSearchResults(results, query) {
    searchResults.innerHTML = "";
    if (results.length === 0) {
        searchResults.innerHTML = `<div style="padding: 10px; color: var(--ink-faint); font-size: 0.85rem; text-align: center;">${t("no_results")}</div>`;
        searchResults.classList.remove("hidden");
        return;
    }

    const frag = document.createDocumentFragment();
    results.slice(0, 8).forEach(movie => {
        const item = document.createElement("div");
        item.className = "search-item";
        
        const posterPath = movie.poster_path ? `${TMDB_IMG_URL}${movie.poster_path}` : PLACEHOLDER_POSTER;
        const year = movie.release_date ? movie.release_date.slice(0, 4) : "N/A";
        const titleHtml = query ? highlightMatch(movie.title || "", query) : (movie.title || "");
        
        item.innerHTML = `
            <img src="${posterPath}" alt="${movie.title}" loading="lazy">
            <div class="search-item-info">
                <span class="search-item-title">${titleHtml}</span>
                <span class="search-item-year">${year} • ⭐ ${movie.vote_average ? movie.vote_average.toFixed(1) : 'N/A'}</span>
            </div>
        `;

        item.addEventListener("click", () => {
            searchPanel.classList.add("hidden");
            searchInput.value = "";
            updateClearBtnVisibility();
            searchResults.classList.add("hidden");
            loadSharedMovie(movie.id); 
        });

        frag.appendChild(item);
    });

    searchResults.appendChild(frag);
    searchResults.classList.remove("hidden");
}

// -----------------------------------------------------------
// 10b. TRENDING, IN-THEATERS & UPCOMING (BOOKMYSHOW-STYLE GRID)
// -----------------------------------------------------------
async function openBrowseScreen(mode, regionCode, regionLabel) {
    searchPanel.classList.add("hidden");
    browseGrid.innerHTML = "";
    browseError.classList.add("hidden");
    browseLoading.textContent = t("browse_loading");
    browseLoading.classList.remove("hidden");
    browseHeading.textContent =
        mode === "theaters" ? t("theaters_heading") :
        mode === "upcoming" ? t("upcoming_heading") :
        mode === "wishlist" ? t("wishlist_heading") :
        t("trending_heading");
    browseTitleTag.textContent = mode === "theaters" ? "🎟️" : mode === "upcoming" ? "📅" : mode === "wishlist" ? "💖" : "🔥";

    const isTheaters = mode === "theaters";
    if (locationChangeBtn) {
        locationChangeBtn.classList.toggle("hidden", !isTheaters);
    }
    if (locationInfo) {
        locationInfo.classList.toggle("hidden", !isTheaters);
    }
    if (locationDisplay) {
        const label = isTheaters ? (regionLabel || getStoredRegionLabel() || "") : "";
        locationDisplay.textContent = label;
        locationDisplay.classList.toggle("hidden", !label);
    }

    showScreen(browseScreen);

    // Wishlist is purely local — no TMDB fetch needed.
    if (mode === "wishlist") {
        browseLoading.classList.add("hidden");
        if (!currentUser) {
            browseError.textContent = t("wishlist_signin_required");
            browseError.classList.remove("hidden");
            return;
        }
        renderBrowseGrid(getWishlist(), "wishlist");
        return;
    }

    try {
        const langParam = TMDB_LANG_MAP[currentLang] || "en-US";
        const region = regionCode || getStoredRegion() || "IN";
        let url;

        if (mode === "theaters") {
            url = `${TMDB_BASE_URL}/movie/now_playing?api_key=${TMDB_API_KEY}&language=${langParam}&region=${region}&page=1`;
        } else if (mode === "upcoming") {
            const today = new Date();
            const in30Days = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);
            const gte = today.toISOString().slice(0, 10);
            const lte = in30Days.toISOString().slice(0, 10);
            url = `${TMDB_BASE_URL}/discover/movie?api_key=${TMDB_API_KEY}&language=${langParam}&region=${region}&sort_by=primary_release_date.asc&primary_release_date.gte=${gte}&primary_release_date.lte=${lte}&with_release_type=2|3`;
        } else {
            url = `${TMDB_BASE_URL}/trending/movie/week?api_key=${TMDB_API_KEY}&language=${langParam}&page=1`;
        }

        const data = await cachedFetchJson(url);
        renderBrowseGrid(data.results || [], mode);
    } catch (err) {
        browseError.textContent = t("browse_error");
        browseError.classList.remove("hidden");
    } finally {
        browseLoading.classList.add("hidden");
    }
}

function renderBrowseGrid(movies, mode) {
    browseGrid.innerHTML = "";
    if (!movies.length) {
        browseError.textContent = mode === "wishlist" ? t("wishlist_empty") : t("browse_error");
        browseError.classList.remove("hidden");
        return;
    }

    const frag = document.createDocumentFragment();
    movies.slice(0, 20).forEach((movie) => {
        const card = document.createElement("div");
        card.className = "browse-card";

        const posterPath = movie.poster_path ? `${TMDB_IMG_URL}${movie.poster_path}` : PLACEHOLDER_POSTER;
        const rating = movie.vote_average ? `⭐ ${movie.vote_average.toFixed(1)}` : "⭐ N/A";

        let dateHtml = "";
        if ((mode === "theaters" || mode === "upcoming") && movie.release_date) {
            const d = new Date(movie.release_date);
            const formatted = isNaN(d) ? movie.release_date : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
            dateHtml = `<div class="browse-card-date">📅 ${formatted}</div>`;
        }

        card.innerHTML = `
            <img src="${posterPath}" alt="${movie.title || ''}" loading="lazy">
            <span class="browse-card-rating">${rating}</span>
            <div class="browse-card-quick-actions">
                <button class="browse-card-wishlist-btn" aria-label="Save to wishlist" title="Save to wishlist">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"></path>
                    </svg>
                </button>
                <button class="browse-card-chat-btn" aria-label="Ask AI about this movie" title="Ask AI">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path>
                    </svg>
                </button>
                <button class="browse-card-explain-btn" aria-label="Explain this movie" title="Explain">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M11 5 6 9H2v6h4l5 4V5z"></path>
                        <path d="M15.5 8.5a5 5 0 0 1 0 7"></path>
                    </svg>
                </button>
            </div>
            <div class="browse-card-info">
                <div class="browse-card-title">${movie.title || ""}</div>
                ${dateHtml}
            </div>
        `;

        card.addEventListener("click", () => {
            loadSharedMovie(movie.id);
        });

        const cardChatBtn = card.querySelector(".browse-card-chat-btn");
        if (cardChatBtn) {
            cardChatBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                openMovieChat(movie);
            });
        }

        const cardExplainBtn = card.querySelector(".browse-card-explain-btn");
        if (cardExplainBtn) {
            cardExplainBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                explainBrowseCard(movie, cardExplainBtn);
            });
        }

        const cardWishlistBtn = card.querySelector(".browse-card-wishlist-btn");
        if (cardWishlistBtn) {
            if (isInWishlist(movie.id)) cardWishlistBtn.classList.add("is-saved");
            cardWishlistBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                toggleWishlist(movie, cardWishlistBtn);
            });
        }

        frag.appendChild(card);
    });

    browseGrid.appendChild(frag);
}

// -----------------------------------------------------------
// 10c. LOCATION / REGION DETECTION (for "In Theaters")
// -----------------------------------------------------------
function getStoredRegion() {
    try {
        return localStorage.getItem("mmm_region");
    } catch (err) {
        return null;
    }
}

function setStoredRegion(code) {
    try {
        localStorage.setItem("mmm_region", code);
    } catch (err) {}
}

function getStoredRegionLabel() {
    try {
        return localStorage.getItem("mmm_region_label");
    } catch (err) {
        return null;
    }
}

function setStoredRegionLabel(label) {
    try {
        if (label) {
            localStorage.setItem("mmm_region_label", label);
        } else {
            localStorage.removeItem("mmm_region_label");
        }
    } catch (err) {}
}

function populateLocationSelect() {
    if (!locationCountrySelect) return;
    locationCountrySelect.innerHTML = "";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = t("location_select_default");
    placeholder.disabled = true;
    placeholder.selected = true;
    locationCountrySelect.appendChild(placeholder);

    COUNTRY_LIST.forEach((country) => {
        const opt = document.createElement("option");
        opt.value = country.code;
        opt.textContent = country.name;
        locationCountrySelect.appendChild(opt);
    });
}

// Reverse-geocodes lat/lng to an ISO country code (plus a human-readable
// "City, Country" label) using a free, keyless API. The code is passed
// straight to TMDB's `region`; the label is just for display so the user can
// see exactly what location was detected (e.g. "Indore, India").
function detectRegionViaGeolocation() {
    return new Promise((resolve, reject) => {
        if (!("geolocation" in navigator)) {
            reject(new Error("geolocation_unsupported"));
            return;
        }
        navigator.geolocation.getCurrentPosition(
            async (pos) => {
                try {
                    const { latitude, longitude } = pos.coords;
                    const geoUrl = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${latitude}&longitude=${longitude}&localityLanguage=en`;
                    const res = await fetch(geoUrl);
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    const data = await res.json();
                    const code = (data.countryCode || "").toUpperCase();
                    if (code) {
                        const city = data.city || data.locality || data.principalSubdivision || "";
                        const country = data.countryName || "";
                        const label = [city, country].filter(Boolean).join(", ");
                        resolve({ code, label });
                    } else {
                        reject(new Error("no_country_code"));
                    }
                } catch (err) {
                    reject(err);
                }
            },
            (err) => reject(err),
            { enableHighAccuracy: false, timeout: 8000, maximumAge: 10 * 60 * 1000 }
        );
    });
}

async function beginLocationDetection() {
    searchPanel.classList.add("hidden");
    browseGrid.innerHTML = "";
    browseError.classList.add("hidden");
    browseLoading.textContent = t("detecting_location");
    browseLoading.classList.remove("hidden");
    browseHeading.textContent = t("theaters_heading");
    browseTitleTag.textContent = "🎟️";
    if (locationChangeBtn) locationChangeBtn.classList.add("hidden");
    showScreen(browseScreen);

    try {
        const { code, label } = await detectRegionViaGeolocation();
        setStoredRegion(code);
        setStoredRegionLabel(label);
        openBrowseScreen("theaters", code, label);
    } catch (err) {
        // Location permission denied, unsupported (e.g. many desktops), or the
        // lookup failed for another reason — fall back to manual entry.
        browseLoading.classList.add("hidden");
        setStoredRegionLabel("");
        openLocationModal();
    }
}

function openLocationModal() {
    const stored = getStoredRegion();
    if (locationCountrySelect && stored) {
        locationCountrySelect.value = stored;
    }
    locationModal.classList.remove("hidden");
}

function closeLocationModal() {
    locationModal.classList.add("hidden");
}

function openSettingsModal() {
    if (settingsModal) settingsModal.classList.remove("hidden");
}

function closeSettingsModal() {
    if (settingsModal) settingsModal.classList.add("hidden");
}

if (settingsBtn) settingsBtn.addEventListener("click", openSettingsModal);
if (settingsModalClose) settingsModalClose.addEventListener("click", closeSettingsModal);
if (settingsModalBackdrop) settingsModalBackdrop.addEventListener("click", closeSettingsModal);

async function theatersBtnHandler() {
    const cached = getStoredRegion();
    if (cached) {
        openBrowseScreen("theaters", cached, getStoredRegionLabel());
        return;
    }
    await beginLocationDetection();
}

if (locationModalClose) locationModalClose.addEventListener("click", closeLocationModal);
if (locationModalBackdrop) locationModalBackdrop.addEventListener("click", closeLocationModal);

if (locationConfirmBtn) {
    locationConfirmBtn.addEventListener("click", () => {
        const code = locationCountrySelect.value;
        if (!code) return;
        const label = locationCountrySelect.options[locationCountrySelect.selectedIndex]
            ? locationCountrySelect.options[locationCountrySelect.selectedIndex].textContent
            : "";
        setStoredRegion(code);
        setStoredRegionLabel(label);
        closeLocationModal();
        openBrowseScreen("theaters", code, label);
    });
}

if (locationRetryBtn) {
    locationRetryBtn.addEventListener("click", () => {
        closeLocationModal();
        beginLocationDetection();
    });
}

if (locationChangeBtn) {
    locationChangeBtn.addEventListener("click", () => {
        openLocationModal();
    });
}

trendingBtn.addEventListener("click", () => openBrowseScreen("trending"));
theatersBtn.addEventListener("click", theatersBtnHandler);
if (upcomingBtn) upcomingBtn.addEventListener("click", () => openBrowseScreen("upcoming"));
browseBackBtn.addEventListener("click", () => showScreen(startScreen));

// -----------------------------------------------------------
// 11. REVEAL SCREEN & ANIMATIONS
// -----------------------------------------------------------
function resolveIndustryAndLanguage() {
    if (!state.resolvedIndustry) {
        state.resolvedIndustry = !state.industry || state.industry === "surprise"
            ? ALL_INDUSTRIES[Math.floor(Math.random() * ALL_INDUSTRIES.length)]
            : state.industry;

        if (state.resolvedIndustry === "south_indian") {
            state.resolvedSouthLanguage = state.southLanguage || "any";
        } else {
            state.resolvedSouthLanguage = null;
        }
    }
}

function goToReveal() {
    if (!state.isAiMode) resolveIndustryAndLanguage();
    showScreen(revealScreen);
    movieResult.classList.add("hidden");
    movieError.classList.add("hidden");
    broadenBtn.classList.add("hidden");

    playClapperboard();

    const minDelay = new Promise((resolve) => setTimeout(resolve, 1200));
    const fetchPromise = state.isAiMode ? fetchAiRecommendations({ reset: true }) : fetchMovies({ reset: true });

    Promise.all([fetchPromise, minDelay]).then(([ok]) => {
        hideClapperboard();
        if (ok && state.candidates.length > 0) {
            revealCurrentMovie();
        } else {
            showMovieError(lastErrorMessage || t("error_no_matches"));
            broadenBtn.classList.remove("hidden");
        }
    });
}

// -----------------------------------------------------------
// 11b. AI RECOMMENDATIONS -> TMDB MATCHING
// -----------------------------------------------------------
// Takes the movie titles Gemini suggested and looks each one up on TMDB so
// we get real poster/rating/overview/genre data, then feeds the results
// into the exact same state.candidates pipeline the rest of the app (swipe,
// skip-to-next, share, trailer, streaming links...) already knows how to
// render.
async function fetchAiRecommendations({ reset }) {
    if (reset) {
        state.candidates = [];
        state.exhaustedPages = true; // this is a one-shot batch from the AI, not paginated
    }

    const movieList = (state.aiRecommendations || []).filter(
        (m) => m && m.title && !state.aiUsedTitles.has(m.title.toLowerCase())
    );

    if (!movieList.length) {
        showMovieError(t("error_no_matches"));
        return false;
    }

    try {
        const langParam = TMDB_LANG_MAP[currentLang] || "en-US";

        const matches = await Promise.allSettled(
            movieList.map(async (m) => {
                state.aiUsedTitles.add(m.title.toLowerCase());
                const query = encodeURIComponent(m.title);

                let data = await cachedFetchJson(
                    `${TMDB_BASE_URL}/search/movie?api_key=${TMDB_API_KEY}&query=${query}&language=${langParam}&include_adult=false${
                        m.year ? `&year=${m.year}` : ""
                    }`
                );
                let match = (data.results || [])[0];

                if (!match) {
                    // Retry without the year filter in case Gemini's year was slightly off.
                    data = await cachedFetchJson(
                        `${TMDB_BASE_URL}/search/movie?api_key=${TMDB_API_KEY}&query=${query}&language=${langParam}&include_adult=false`
                    );
                    match = (data.results || [])[0];
                }

                if (match) match._aiReason = m.reason || "";
                return match;
            })
        );

        const seenIds = new Set(state.candidates.map((c) => c.id));
        const fresh = matches
            .filter((r) => r.status === "fulfilled" && r.value)
            .map((r) => r.value)
            .filter((movie) => !state.shownMovieIds.has(movie.id) && !seenIds.has(movie.id));

        state.candidates.push(...fresh);

        if (!state.candidates.length) {
            showMovieError(t("error_no_matches"));
            broadenBtn.classList.remove("hidden");
            return false;
        }

        movieError.classList.add("hidden");
        return true;
    } catch (err) {
        showMovieError(t("error_network"));
        return false;
    }
}

// Asks Gemini for a fresh batch of recommendations, excluding what it has
// already suggested, when the user wants to broaden past the first batch.
async function broadenAiSearch() {
    broadenBtn.disabled = true;
    setQuizLoadingOnReveal(true);

    try {
        const usedTitles = [...state.aiUsedTitles];
        const prompt = `${buildAiPrompt()}\n\nThe user wants different options. Do NOT suggest any of these already-shown movies: ${usedTitles.join(
            ", "
        )}. Give a fresh set of 6 real movies as the same {"type":"recommendation","movies":[...]} JSON shape.`;

        const data = await callGemini(prompt);
        setQuizLoadingOnReveal(false);
        broadenBtn.disabled = false;

        if (data && data.type === "recommendation" && Array.isArray(data.movies) && data.movies.length) {
            state.aiRecommendations = data.movies;
            const ok = await fetchAiRecommendations({ reset: true });
            if (ok) {
                broadenBtn.classList.add("hidden");
                revealCurrentMovie();
            }
        } else {
            showMovieError(t("error_no_matches"));
        }
    } catch (err) {
        setQuizLoadingOnReveal(false);
        broadenBtn.disabled = false;
        showMovieError(t("error_network"));
    }
}

function setQuizLoadingOnReveal(isLoading) {
    if (isLoading) {
        playClapperboard();
    } else {
        hideClapperboard();
    }
}

function playClapperboard() {
    clapperboardText.textContent = t("gift_wrapping");
    clapperboardContainer.classList.remove("hidden");
    const board = document.getElementById("clapperboard");
    board.classList.remove("clap-anim");
    void board.offsetWidth;
    board.classList.add("clap-anim");
    setTimeout(() => playClapSound(), 90);
}

function hideClapperboard() {
    clapperboardContainer.classList.add("hidden");
    document.getElementById("clapperboard").classList.remove("clap-anim");
}

// -----------------------------------------------------------
// 12. TMDB FETCHING
// -----------------------------------------------------------
const TMDB_FETCH_TIMEOUT_MS = 7000;

function fetchWithTimeout(url, ms, options = {}) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), ms);
    return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(id));
}

// Some Indian ISPs (Jio in particular) are known to silently block or
// heavily throttle api.themoviedb.org at the network/DNS level for certain
// users — the site loads instantly on other networks (or with a VPN), which
// is the signature of an ISP-side block rather than a bug in the app itself.
// As a mitigation, if the direct TMDB request fails or times out, we retry
// once through a public read-only relay that performs the same request
// server-side. Since the block sits on the client's route to
// themoviedb.org specifically, fetching via a different server sidesteps it
// without requiring the user to turn on a VPN.
function viaProxy(url) {
    return `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
}

async function cachedFetchJson(url) {
    if (requestCache.has(url)) return requestCache.get(url);

    let data;
    try {
        const res = await fetchWithTimeout(url, TMDB_FETCH_TIMEOUT_MS);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        data = await res.json();
    } catch (directErr) {
        try {
            const res = await fetchWithTimeout(viaProxy(url), TMDB_FETCH_TIMEOUT_MS);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            data = await res.json();
        } catch (proxyErr) {
            throw directErr;
        }
    }

    requestCache.set(url, data);
    return data;
}

function buildDiscoverUrl(page, language) {
    const uniqueGenres = [...new Set(state.genrePool)].filter((g) => !state.excludeGenres.has(g));
    const minVotes =
        state.resolvedIndustry === "south_indian"
            ? INDUSTRY_CONFIG.south_indian.minVotes
            : INDUSTRY_CONFIG[state.resolvedIndustry].minVotes;

    const params = new URLSearchParams({
        api_key: TMDB_API_KEY,
        with_original_language: language,
        language: TMDB_LANG_MAP[currentLang] || "en-US",
        sort_by: "popularity.desc",
        "vote_count.gte": String(minVotes),
        include_adult: "false",
        page: String(page)
    });
    if (uniqueGenres.length) {
        params.set("with_genres", uniqueGenres.join("|"));
    }
    if (state.excludeGenres.size) {
        params.set("without_genres", [...state.excludeGenres].join(","));
    }
    if (state.dateRange) {
        params.set("primary_release_date.gte", state.dateRange.gte);
        params.set("primary_release_date.lte", state.dateRange.lte);
    }
    return `${TMDB_BASE_URL}/discover/movie?${params.toString()}`;
}

async function discoverPage(language, page) {
    const url = buildDiscoverUrl(page, language);
    return cachedFetchJson(url);
}

function scoreMovie(movie) {
    const genreScore = (movie.genre_ids || []).reduce((sum, id) => {
        const occurrences = state.genrePool.filter((g) => g === id).length;
        return sum + occurrences;
    }, 0);
    return genreScore * 1000 + (movie.popularity || 0);
}

async function fetchMovies({ reset }) {
    if (!TMDB_API_KEY || TMDB_API_KEY === "YOUR_TMDB_API_KEY_HERE") {
        showMovieError(t("error_no_key"));
        return false;
    }

    if (reset) {
        state.candidates = [];
        state.singlePage = 1;
        state.singleTotalPages = 1;
        state.southAnyPages = { te: 1, ta: 1, kn: 1, ml: 1 };
        state.exhaustedPages = false;
    }

    try {
        let newResults = [];

        if (state.isRandomMode) {
            const randPage = () => Math.floor(Math.random() * 15) + 1;
            const randomSouthLang = SOUTH_ANY_LANGS[Math.floor(Math.random() * SOUTH_ANY_LANGS.length)];
            
            const urls = [
                `${TMDB_BASE_URL}/discover/movie?api_key=${TMDB_API_KEY}&with_original_language=en&page=${randPage()}&vote_count.gte=100`,
                `${TMDB_BASE_URL}/discover/movie?api_key=${TMDB_API_KEY}&with_original_language=hi&page=${randPage()}&vote_count.gte=20`,
                `${TMDB_BASE_URL}/discover/movie?api_key=${TMDB_API_KEY}&with_original_language=${randomSouthLang}&page=${randPage()}&vote_count.gte=8`
            ];

            const responses = await Promise.allSettled(urls.map(url => cachedFetchJson(url)));
            responses.forEach(res => {
                if (res.status === "fulfilled" && res.value.results) {
                    newResults.push(...res.value.results);
                }
            });
        } else {
            if (state.resolvedIndustry === "south_indian" && state.resolvedSouthLanguage === "any") {
                const responses = await Promise.all(
                    SOUTH_ANY_LANGS.map((lang) =>
                        discoverPage(lang, state.southAnyPages[lang]).catch(() => ({ results: [], total_pages: 1 }))
                    )
                );
                responses.forEach((res, i) => {
                    const lang = SOUTH_ANY_LANGS[i];
                    newResults.push(...(res.results || []));
                    state.southAnyPages[lang] = Math.min(state.southAnyPages[lang] + 1, res.total_pages || 1);
                });
            } else {
                const language =
                    state.resolvedIndustry === "south_indian"
                        ? SOUTH_LANG_MAP[state.resolvedSouthLanguage]
                        : INDUSTRY_CONFIG[state.resolvedIndustry].language;

                const first = await discoverPage(language, state.singlePage);
                state.singleTotalPages = first.total_pages || 1;
                let results = first.results || [];

                if (reset) {
                    const maxRandom = Math.min(state.singleTotalPages, 20);
                    if (maxRandom > 1) {
                        const randomPage = Math.floor(Math.random() * maxRandom) + 1;
                        if (randomPage !== 1) {
                            const randData = await discoverPage(language, randomPage);
                            results = randData.results || [];
                            state.singlePage = randomPage;
                        }
                    }
                }
                newResults.push(...results);
                state.singlePage += 1;
            }
        }

        const existingIds = new Set(state.candidates.map((c) => c.id));
        const fresh = newResults.filter((m) => !state.shownMovieIds.has(m.id) && !existingIds.has(m.id));

        if (state.isRandomMode) {
            fresh.sort(() => Math.random() - 0.5);
        } else {
            fresh.sort((a, b) => scoreMovie(b) - scoreMovie(a));
        }

        state.candidates.push(...fresh);

        if (!fresh.length) {
            state.exhaustedPages = true;
        }

        if (!state.candidates.length) {
            showMovieError(t("error_no_matches"));
            broadenBtn.classList.remove("hidden");
            return false;
        }

        movieError.classList.add("hidden");
        return true;
    } catch (err) {
        showMovieError(t("error_network"));
        return false;
    }
}

function showMovieError(message) {
    lastErrorMessage = message;
    movieError.textContent = message;
    movieError.classList.remove("hidden");
}

// -----------------------------------------------------------
// 13. BROADEN SEARCH
// -----------------------------------------------------------
async function broadenSearch() {
    if (state.isAiMode) {
        return broadenAiSearch();
    }

    broadenBtn.disabled = true;

    if (state.dateRange) {
        state.dateRange = null;
    } else if (state.excludeGenres.size) {
        state.excludeGenres.clear();
    } else if (state.genrePool.length) {
        state.genrePool.pop();
    } else {
        showMovieError(t("error_no_matches"));
        broadenBtn.disabled = false;
        return;
    }

    const ok = await fetchMovies({ reset: true });
    broadenBtn.disabled = false;

    if (ok) {
        broadenBtn.classList.add("hidden");
        revealCurrentMovie();
    }
}

broadenBtn.addEventListener("click", broadenSearch);

// -----------------------------------------------------------
// 14. RENDERING A MOVIE
// -----------------------------------------------------------
function revealCurrentMovie() {
    const movie = state.candidates.shift();
    movieResult.classList.remove("hidden");

    if (!movie) {
        showMovieError(t("exhausted_msg"));
        broadenBtn.classList.remove("hidden");
        return;
    }

    state.shownMovieIds.add(movie.id);
    state.currentMovie = movie;
    renderMovie(movie);
    loadMovieExtras(movie.id);
    maybeShowSwipeHintPulse();
}

// Nudges first-time visitors that the poster is swipeable, once, then
// never again (tracked via localStorage) so it doesn't get annoying.
function maybeShowSwipeHintPulse() {
    if (!moviePosterWrap) return;
    let seen = false;
    try {
        seen = localStorage.getItem("popcornnight_seen_swipe_hint") === "1";
    } catch (e) {}
    if (seen) return;
    setTimeout(() => {
        moviePosterWrap.classList.add("swipe-hint-pulse");
        setTimeout(() => moviePosterWrap.classList.remove("swipe-hint-pulse"), 3300);
    }, 900);
    try {
        localStorage.setItem("popcornnight_seen_swipe_hint", "1");
    } catch (e) {}
}

function renderMovie(movie) {
    movieError.classList.add("hidden");
    broadenBtn.classList.add("hidden");

    // Stop any in-progress "Explain" narration from the previous movie.
    if (typeof isExplainBusy !== "undefined" && isExplainBusy) {
        if ("speechSynthesis" in window) window.speechSynthesis.cancel();
        isExplainBusy = false;
        setExplainBtnState("idle");
    }

    movieTitle.textContent = movie.title || "Untitled";
    const baseOverview = movie.overview
        ? movie.overview
        : "No description available for this one — sometimes the best surprises come unlabeled.";
    movieOverview.textContent = movie._aiReason ? `🎬 ${movie._aiReason}\n\n${baseOverview}` : baseOverview;
    movieRating.textContent = movie.vote_average ? `⭐ ${movie.vote_average.toFixed(1)}` : "⭐ N/A";
    moviePoster.src = movie.poster_path ? `${TMDB_IMG_URL}${movie.poster_path}` : PLACEHOLDER_POSTER;
    if (moviePosterWrap) moviePosterWrap.classList.add("is-loading-poster");
    moviePoster.alt = `${movie.title || "Movie"} poster`;
    renderGenres(movie);

    // Ken-Burns zoom: strip then re-add the class so the animation restarts
    // cleanly for every new movie (repeated classList adds don't retrigger).
    moviePoster.classList.remove("poster-kenburns");
    void moviePoster.offsetWidth;
    moviePoster.classList.add("poster-kenburns");

    // Dynamic poster-as-color-theme + Recently Viewed + Why-you'll-like badge
    extractPosterAccentColor(moviePoster, moviePosterWrap);
    renderWhyYoullLikeBadge(movie);
    addToRecentlyViewed(movie);
    updateAffiliateTicketLink(movie);

    if (movie.backdrop_path) {
        revealBackdrop.style.backgroundImage = `url(${TMDB_BACKDROP_URL}${movie.backdrop_path})`;
        revealBackdrop.classList.add("visible");
    } else {
        revealBackdrop.classList.remove("visible");
    }

    if (movie.release_date) {
        movieYear.textContent = movie.release_date.slice(0, 4);
        movieYear.classList.remove("hidden");
    } else {
        movieYear.classList.add("hidden");
    }
    movieRuntime.classList.add("hidden");
    trailerLink.classList.add("hidden");
    delete trailerLink.dataset.videoKey;
    youtubeFreeLink.classList.add("hidden");
    freeSection.classList.add("hidden");
    platformsSection.classList.add("hidden");
    streamingNone.classList.add("hidden");

    if (movieWishlistBtn) {
        movieWishlistBtn.classList.toggle("is-saved", currentUser ? isInWishlist(movie.id) : false);
    }
    rememberLastMovie(movie);
}

function renderGenres(movie) {
    movieGenres.innerHTML = "";
    const ids = (movie.genre_ids || []).slice(0, 3);
    const labels = ids.map((id) => genreLabel(id)).filter(Boolean);
    if (!labels.length) {
        movieGenres.classList.add("hidden");
        return;
    }
    labels.forEach((g) => {
        const chip = document.createElement("span");
        chip.className = "genre-chip";
        chip.textContent = `${g.icon} ${g.label}`;
        movieGenres.appendChild(chip);
    });
    movieGenres.classList.remove("hidden");
}

function buildPlatformPill(provider) {
    const pill = document.createElement("span");
    pill.className = "platform-pill";
    if (provider.logo_path) {
        const img = document.createElement("img");
        img.src = `${TMDB_LOGO_URL}${provider.logo_path}`;
        img.alt = provider.provider_name || "";
        img.loading = "lazy";
        pill.appendChild(img);
    }
    const name = document.createElement("span");
    name.textContent = provider.provider_name || "";
    pill.appendChild(name);
    return pill;
}

async function loadMovieExtras(movieId) {
    const langParam = TMDB_LANG_MAP[currentLang] || "en-US";
    const detailsUrl = `${TMDB_BASE_URL}/movie/${movieId}?api_key=${TMDB_API_KEY}&language=${langParam}`;
    const videosUrl = `${TMDB_BASE_URL}/movie/${movieId}/videos?api_key=${TMDB_API_KEY}&language=${langParam}`;
    const providersUrl = `${TMDB_BASE_URL}/movie/${movieId}/watch/providers?api_key=${TMDB_API_KEY}`;

    const [detailsRes, videosRes, providersRes] = await Promise.allSettled([
        cachedFetchJson(detailsUrl),
        cachedFetchJson(videosUrl),
        cachedFetchJson(providersUrl)
    ]);

    if (!state.currentMovie || state.currentMovie.id !== movieId) return;

    if (detailsRes.status === "fulfilled" && detailsRes.value.runtime) {
        movieRuntime.textContent = t("runtime_label", { min: detailsRes.value.runtime });
        movieRuntime.classList.remove("hidden");
    }

    let hasFreeYoutube = false;

    if (videosRes.status === "fulfilled") {
        const vids = videosRes.value.results || [];
        const trailer =
            vids.find((v) => v.site === "YouTube" && v.type === "Trailer" && v.official) ||
            vids.find((v) => v.site === "YouTube" && v.type === "Trailer") ||
            vids.find((v) => v.site === "YouTube");
        if (trailer) {
            trailerLink.href = `https://www.youtube.com/watch?v=${trailer.key}`;
            trailerLink.dataset.videoKey = trailer.key;
            trailerLink.textContent = t("trailer_btn");
            trailerLink.classList.remove("hidden");
        } else {
            delete trailerLink.dataset.videoKey;
        }
        const fullMovie = vids.find(
            (v) => v.site === "YouTube" && /full movie|feature/i.test(v.type || v.name || "")
        );
        if (fullMovie) {
            youtubeFreeLink.href = `https://www.youtube.com/watch?v=${fullMovie.key}`;
            hasFreeYoutube = true;
        }
    }

    if (providersRes.status === "fulfilled") {
        const results = providersRes.value.results || {};
        const region = results.US || results.IN || Object.values(results)[0];

        if (region) {
            const freeProviders = [...(region.free || []), ...(region.ads || [])];
            const dedupedFree = [];
            const freeIds = new Set();
            freeProviders.forEach((p) => {
                if (!freeIds.has(p.provider_id)) {
                    freeIds.add(p.provider_id);
                    dedupedFree.push(p);
                }
            });

            if (dedupedFree.length) {
                freePlatforms.innerHTML = "";
                dedupedFree.forEach((p) => freePlatforms.appendChild(buildPlatformPill(p)));
                freeSection.classList.remove("hidden");

                const youtubeFree = dedupedFree.find((p) => /youtube/i.test(p.provider_name || ""));
                if (youtubeFree && !hasFreeYoutube) {
                    const query = encodeURIComponent(`${movieTitle.textContent} full movie`);
                    youtubeFreeLink.href = `https://www.youtube.com/results?search_query=${query}`;
                    hasFreeYoutube = true;
                }
            }

            const flatrate = region.flatrate || [];
            if (flatrate.length) {
                streamingPlatforms.innerHTML = "";
                flatrate.forEach((p) => streamingPlatforms.appendChild(buildPlatformPill(p)));
                platformsSection.classList.remove("hidden");
                markOwnedPlatforms(streamingPlatforms);
            } else if (!dedupedFree.length) {
                streamingNone.classList.remove("hidden");
            }
        } else {
            streamingNone.classList.remove("hidden");
        }
    }

    if (hasFreeYoutube) {
        youtubeFreeLink.textContent = t("youtube_free_btn");
        youtubeFreeLink.classList.remove("hidden");
    }
}

// -----------------------------------------------------------
// 15. BUTTON & SWIPE HANDLERS
// -----------------------------------------------------------
let nextMovieCooldown = false;

async function goToNextMovie() {
    if (nextMovieCooldown) return;
    nextMovieCooldown = true;
    nextMovieBtn.disabled = true;

    if (!state.candidates.length && !state.exhaustedPages) {
        await fetchMovies({ reset: false });
    }

    if (!state.candidates.length) {
        showMovieError(t("exhausted_msg"));
        broadenBtn.classList.remove("hidden");
    } else {
        revealCurrentMovie();
    }

    setTimeout(() => {
        nextMovieCooldown = false;
        nextMovieBtn.disabled = false;
    }, 300);
}

nextMovieBtn.addEventListener("click", goToNextMovie);

// Swipe Left or Right to skip
(function setupSwipe() {
    const card = document.getElementById("movie-card");
    if (!card) return;

    const SWIPE_THRESHOLD = 80;
    let startX = 0;
    let startY = 0;
    let dx = 0;
    let dragging = false;
    let pointerId = null;
    let lockedAxis = null;

    function setTransform(x, animate) {
        card.style.transition = animate ? "transform 0.3s ease, opacity 0.3s ease" : "none";
        const rotate = Math.max(-14, Math.min(14, x / 12));
        card.style.transform = `translateX(${x}px) rotate(${rotate}deg)`;
        card.style.opacity = String(Math.max(0.3, 1 - Math.abs(x) / 380));
    }

    function resetCard() {
        setTransform(0, true);
    }

    function onPointerDown(e) {
        if (nextMovieCooldown) return;
        if (e.target.closest("a, button")) return;
        dragging = true;
        lockedAxis = null;
        pointerId = e.pointerId;
        startX = e.clientX;
        startY = e.clientY;
        dx = 0;
        card.setPointerCapture && card.setPointerCapture(pointerId);
    }

    function onPointerMove(e) {
        if (!dragging) return;
        const moveX = e.clientX - startX;
        const moveY = e.clientY - startY;

        if (!lockedAxis) {
            if (Math.abs(moveX) < 6 && Math.abs(moveY) < 6) return;
            lockedAxis = Math.abs(moveX) > Math.abs(moveY) ? "x" : "y";
        }
        if (lockedAxis !== "x") return;

        dx = moveX;
        e.preventDefault();
        setTransform(dx, false);
    }

    function onPointerUp() {
        if (!dragging) return;
        dragging = false;

        if (lockedAxis === "x" && Math.abs(dx) > SWIPE_THRESHOLD) {
            playSwipeSound(dx > 0 ? "right" : "left");
            hapticFeedback(15);
            const flyDistance = dx > 0 ? window.innerWidth : -window.innerWidth;
            card.style.transition = "transform 0.32s ease-out, opacity 0.32s ease-out";
            card.style.transform = `translateX(${flyDistance}px) rotate(${dx > 0 ? 22 : -22}deg)`;
            card.style.opacity = "0";

            goToNextMovie();

            setTimeout(() => {
                card.style.transition = "none";
                card.style.transform = "translateX(0) rotate(0deg)";
                card.style.opacity = "1";
            }, 350);
        } else {
            resetCard();
        }
        lockedAxis = null;
    }

    card.addEventListener("pointerdown", onPointerDown);
    card.addEventListener("pointermove", onPointerMove, { passive: false });
    card.addEventListener("pointerup", onPointerUp);
    card.addEventListener("pointercancel", onPointerUp);
})();

startBtn.addEventListener("click", () => {
    startQuiz();
});

// -----------------------------------------------------------
// 15b. INLINE TRAILER MODAL (no more bouncing to YouTube)
// -----------------------------------------------------------
// Uses a plain <iframe> embed rather than the YouTube IFrame *Player* API:
// the Player API needs postMessage communication over a real http(s) origin
// to report playback state/errors, which breaks when the site is opened as
// a local file:// page (as in VS Code's built-in preview) — every trailer
// would falsely appear "broken". A plain iframe embed has no such
// requirement and works the same whether the site is opened locally or
// hosted online. We pair it with an always-visible YouTube link so that if
// a specific trailer truly has embedding disabled by its owner, there's
// still a one-tap way to watch it.
function openTrailerModal(videoKey) {
    if (!videoKey) return;
    trailerModalFrame.innerHTML = `<iframe src="https://www.youtube.com/embed/${videoKey}?autoplay=1&rel=0" title="Trailer" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>`;
    if (trailerFallbackLink) {
        trailerFallbackLink.href = `https://www.youtube.com/watch?v=${videoKey}`;
        trailerFallbackLink.textContent = t("trailer_fallback_link");
        trailerFallbackLink.classList.remove("hidden");
    }
    trailerModal.classList.remove("hidden");
}

function closeTrailerModal() {
    trailerModal.classList.add("hidden");
    trailerModalFrame.innerHTML = "";
    if (trailerFallbackLink) {
        trailerFallbackLink.classList.add("hidden");
        trailerFallbackLink.removeAttribute("href");
    }
}

trailerLink.addEventListener("click", (e) => {
    const key = trailerLink.dataset.videoKey;
    if (key) {
        e.preventDefault();
        openTrailerModal(key);
    }
});

trailerModalClose.addEventListener("click", closeTrailerModal);
trailerModalBackdrop.addEventListener("click", closeTrailerModal);
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !trailerModal.classList.contains("hidden")) closeTrailerModal();
});

// -----------------------------------------------------------
// 15c. AI MOVIE CHAT (floating chat button on every movie card)
// -----------------------------------------------------------
let chatMovieContext = null; // the movie currently being discussed
let chatHistory = [];        // [{role: "user"|"bot", text}]
let chatBusy = false;

function movieContextText(movie) {
    if (!movie) return "";
    const title = movie.title || "Untitled";
    const year = (movie.release_date || "").slice(0, 4);
    const rating = movie.vote_average ? movie.vote_average.toFixed(1) : "N/A";
    const overview = movie.overview || "No overview available.";
    const genres = (movie.genre_ids || [])
        .map((id) => genreLabel(id))
        .filter(Boolean)
        .map((g) => g.label)
        .join(", ");
    return `Title: ${title}\nYear: ${year || "Unknown"}\nGenres: ${genres || "Unknown"}\nTMDB Rating: ${rating}\nOverview: ${overview}`;
}

function openMovieChat(movie) {
    if (!movie) return;
    chatMovieContext = movie;
    chatHistory = [];
    movieChatSubtitle.textContent = movie.title || "";
    movieChatMessages.innerHTML = "";
    appendChatBubble("bot", t("chat_greeting", { title: movie.title || "" }));
    movieChatModal.classList.remove("hidden");
    setTimeout(() => movieChatInput.focus(), 150);
}

function closeMovieChat() {
    movieChatModal.classList.add("hidden");
}

function appendChatBubble(role, text) {
    const bubble = document.createElement("div");
    bubble.className = `chat-bubble chat-bubble-${role}`;
    bubble.textContent = text;
    movieChatMessages.appendChild(bubble);
    movieChatMessages.scrollTop = movieChatMessages.scrollHeight;
    return bubble;
}

function buildChatPrompt(question) {
    const langLabel = currentLang === "hi" ? "Hindi, written in the Devanagari script (हिंदी)" : "English";
    const historyText = chatHistory
        .map((h) => `${h.role === "user" ? "User" : "Reel"}: ${h.text}`)
        .join("\n");

    const spoilerInstruction = (spoilerToggleInput && spoilerToggleInput.checked)
        ? "The user has turned ON spoiler-safe mode: NEVER reveal the ending, plot twists, or major reveals, even if directly asked — politely decline and offer a spoiler-free angle instead."
        : "The user has turned OFF spoiler-safe mode (they've likely seen it or don't mind): feel free to discuss the ending, twists, and plot details freely when asked.";

    const compareInstruction = /\bvs\b|\bversus\b|compare|should i watch .* or /i.test(question)
        ? "\n\nThe user seems to be asking you to COMPARE this movie with another title. Give a short, structured verdict: 2-3 lines on how the two differ (tone, pacing, themes), then a clear one-line recommendation of which to watch tonight and why."
        : "";

    return `You are "Reel", a friendly, knowledgeable movie-chat assistant inside a movie app called PopcornNight. You are currently discussing ONE specific movie with the user, described below. Answer only using what you know (plot, cast, themes, ending, trivia, similar movies, etc.) — if you're unsure of a detail, say so honestly instead of making it up. Keep replies short and conversational, 2-4 sentences unless the user clearly wants more detail. ${spoilerInstruction}${compareInstruction}

Movie details:
${movieContextText(chatMovieContext)}

Conversation so far:
${historyText || "(nothing yet)"}

User: ${question}

Reply with ONLY your spoken reply text, in ${langLabel}, no labels, no markdown, no quotes.`;
}

async function sendChatMessage(question) {
    if (!question || chatBusy) return;
    chatBusy = true;
    hapticFeedback(10);
    movieChatSend.disabled = true;
    appendChatBubble("user", question);
    chatHistory.push({ role: "user", text: question });

    const thinkingBubble = appendChatBubble("bot", "");
    thinkingBubble.classList.add("chat-bubble-thinking");
    thinkingBubble.innerHTML = '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';

    try {
        const reply = await callGeminiText(buildChatPrompt(question));
        thinkingBubble.remove();
        appendChatBubble("bot", reply);
        chatHistory.push({ role: "bot", text: reply });
    } catch (err) {
        thinkingBubble.remove();
        appendChatBubble("bot", t("chat_error"));
    } finally {
        chatBusy = false;
        movieChatSend.disabled = false;
    }
}

if (movieChatFab) {
    movieChatFab.addEventListener("click", () => openMovieChat(state && state.currentMovie));
}
if (movieChatClose) movieChatClose.addEventListener("click", closeMovieChat);
if (movieChatBackdrop) movieChatBackdrop.addEventListener("click", closeMovieChat);
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && movieChatModal && !movieChatModal.classList.contains("hidden")) closeMovieChat();
});
if (movieChatForm) {
    movieChatForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const val = movieChatInput.value.trim();
        if (!val) return;
        movieChatInput.value = "";
        sendChatMessage(val);
    });
}

// -----------------------------------------------------------
// 15d. EXPLAIN MOVIE (spoken explanation in selected language)
// -----------------------------------------------------------
let isExplainBusy = false;
let explainVoicesReady = false;

function primeSpeechVoices() {
    if (!("speechSynthesis" in window)) return;
    // Voices load asynchronously in most browsers; touching getVoices() once
    // and listening for the change event ensures we have the list ready by
    // the time the user actually taps "Explain".
    window.speechSynthesis.getVoices();
    window.speechSynthesis.addEventListener("voiceschanged", () => {
        explainVoicesReady = true;
    }, { once: true });
}
primeSpeechVoices();

function pickVoiceForLang(langCode) {
    if (!("speechSynthesis" in window)) return null;
    const voices = window.speechSynthesis.getVoices() || [];
    if (!voices.length) return null;
    const prefix = langCode.split("-")[0];
    return (
        voices.find((v) => v.lang && v.lang.toLowerCase() === langCode.toLowerCase()) ||
        voices.find((v) => v.lang && v.lang.toLowerCase().startsWith(prefix)) ||
        null
    );
}

let explainPersona = "eli5"; // "eli5" | "critic"

if (personaEli5Btn && personaCriticBtn) {
    personaEli5Btn.addEventListener("click", () => {
        explainPersona = "eli5";
        personaEli5Btn.classList.add("active");
        personaCriticBtn.classList.remove("active");
    });
    personaCriticBtn.addEventListener("click", () => {
        explainPersona = "critic";
        personaCriticBtn.classList.add("active");
        personaEli5Btn.classList.remove("active");
    });
}

function setExplainBtnState(state_) {
    // state_: "idle" | "loading" | "speaking"
    if (!movieExplainBtn) return;
    movieExplainBtn.classList.remove("is-loading", "is-speaking");
    if (explainWaveform) explainWaveform.classList.toggle("hidden", state_ !== "speaking");
    if (state_ === "loading") {
        movieExplainBtn.classList.add("is-loading");
        movieExplainBtnText.textContent = explainPersona === "critic" ? t("explain_loading_critic") : t("explain_loading_eli5");
    } else if (state_ === "speaking") {
        movieExplainBtn.classList.add("is-speaking");
        movieExplainBtnText.textContent = t("explain_speaking");
    } else {
        movieExplainBtnText.textContent = t("explain_btn");
    }
}

// Response caching (API cost saver): one cached explanation per
// movie+persona+language combo, so repeat taps/visits cost 0ms + $0.
function explainCacheKey(movie, persona) {
    return `popcornnight_explain_${movie.id}_${persona}_${currentLang}`;
}

function getCachedExplain(movie, persona) {
    try {
        return localStorage.getItem(explainCacheKey(movie, persona));
    } catch (e) { return null; }
}

function setCachedExplain(movie, persona, text) {
    try { localStorage.setItem(explainCacheKey(movie, persona), text); } catch (e) {}
}

function buildExplainPrompt(movie, persona) {
    const langLabel = currentLang === "hi" ? "Hindi, written in the Devanagari script (हिंदी)" : "English";
    const personaLine = persona === "critic"
        ? "Speak like a sharp, articulate film critic — reference tone, direction, performances, and craft, still in plain spoken language (not academic jargon)."
        : "Speak like you're explaining it to a curious friend who knows nothing about movies yet — very simple words, short sentences, zero jargon (Explain Like I'm 5 style), but still engaging for an adult.";
    return `You are "Reel", a movie-explainer voice assistant inside a movie app called PopcornNight. Explain the following movie to someone deciding whether to watch it tonight: what it's about, the vibe/tone, and why it's worth (or not worth) watching. ${personaLine} Keep it to about 5-7 sentences. Do not reveal major twist endings.

Movie details:
${movieContextText(movie)}

Reply with ONLY the spoken explanation text, in ${langLabel}, no labels, no markdown, no quotes, no headings.`;
}

// Splits narration text into sentence-sized chunks so we can start speaking
// the first sentence the instant it's ready, instead of waiting for the
// whole reply — combined with streamExplainText() below this
// gives a real "snappy" streaming feel instead of one long wait.
function splitIntoSentences(text) {
    return (text.match(/[^.!?।]+[.!?।]*/g) || [text]).map((s) => s.trim()).filter(Boolean);
}

function speakQueue(sentences, langCode, onFirstStart, onAllDone) {
    if (!sentences.length) { onAllDone(); return; }
    let i = 0;
    let startedOnce = false;
    function speakNext() {
        if (!isExplainBusy) return;
        if (i >= sentences.length) { onAllDone(); return; }
        const utterance = new SpeechSynthesisUtterance(sentences[i]);
        utterance.lang = langCode;
        const voice = pickVoiceForLang(langCode);
        if (voice) utterance.voice = voice;
        utterance.rate = 1;
        utterance.onstart = () => {
            if (!startedOnce) { startedOnce = true; onFirstStart(); }
        };
        utterance.onend = () => { i += 1; speakNext(); };
        utterance.onerror = () => { i += 1; speakNext(); };
        window.speechSynthesis.speak(utterance);
    }
    speakNext();
}

// Streams the Gemini reply via streamGenerateContent so narration can begin
// on the first completed sentence rather than waiting for the full text.
async function streamExplainText(promptText, onSentenceReady) {
    if (!GEMINI_API_KEY || GEMINI_API_KEY === "YOUR_GEMINI_API_KEY_HERE") {
        throw new Error("no-gemini-key");
    }
    const streamUrl = GEMINI_URL.replace(":generateContent", ":streamGenerateContent");
    const res = await fetchWithTimeout(streamUrl, AI_FETCH_TIMEOUT_MS, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
        body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: promptText }] }],
            generationConfig: { temperature: 0.9 }
        })
    });
    if (!res.ok || !res.body) {
        // Fall back to non-streaming call if streaming isn't available.
        const full = await callGeminiText(promptText);
        onSentenceReady(full);
        return full;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";
    let spoken = "";

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // The stream is a JSON array of objects arriving incrementally; pull
        // out any complete "text": "..." fields we can find so far.
        let match;
        const textRegex = /"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
        let localBuffer = buffer;
        while ((match = textRegex.exec(localBuffer)) !== null) {
            try {
                const chunk = JSON.parse(`"${match[1]}"`);
                if (!fullText.endsWith(chunk)) fullText += chunk;
            } catch (e) {}
        }

        const unspokenSoFar = fullText.slice(spoken.length);
        const sentences = splitIntoSentences(unspokenSoFar);
        // Speak all but the possibly-incomplete last sentence.
        if (sentences.length > 1) {
            for (let s = 0; s < sentences.length - 1; s++) {
                onSentenceReady(sentences[s]);
                spoken += sentences[s] + " ";
            }
        }
    }
    const remaining = fullText.slice(spoken.length).trim();
    if (remaining) onSentenceReady(remaining);
    return fullText;
}

async function explainMovie(movie) {
    if (!movie || !movieExplainBtn) return;
    if (!("speechSynthesis" in window)) {
        appendExplainError();
        return;
    }

    // Tap again while speaking/loading -> stop.
    if (isExplainBusy) {
        window.speechSynthesis.cancel();
        isExplainBusy = false;
        setExplainBtnState("idle");
        return;
    }

    isExplainBusy = true;
    hapticFeedback(12);
    setExplainBtnState("loading");
    const langCode = TMDB_LANG_MAP[currentLang] || "en-US";
    const persona = explainPersona;

    const finishUp = () => {
        isExplainBusy = false;
        setExplainBtnState("idle");
    };

    try {
        const cached = getCachedExplain(movie, persona);
        if (cached) {
            const sentences = splitIntoSentences(cached);
            speakQueue(sentences, langCode, () => setExplainBtnState("speaking"), finishUp);
            return;
        }

        const sentenceQueue = [];
        let queueRunning = false;
        let streamDone = false;
        let fullCollected = "";

        function pump() {
            if (queueRunning) return;
            if (!sentenceQueue.length) {
                if (streamDone) finishUp();
                return;
            }
            queueRunning = true;
            const next = sentenceQueue.shift();
            const utterance = new SpeechSynthesisUtterance(next);
            utterance.lang = langCode;
            const voice = pickVoiceForLang(langCode);
            if (voice) utterance.voice = voice;
            utterance.rate = 1;
            utterance.onstart = () => setExplainBtnState("speaking");
            utterance.onend = () => { queueRunning = false; pump(); };
            utterance.onerror = () => { queueRunning = false; pump(); };
            window.speechSynthesis.speak(utterance);
        }

        window.speechSynthesis.cancel();
        fullCollected = await streamExplainText(buildExplainPrompt(movie, persona), (sentence) => {
            if (!isExplainBusy) return;
            sentenceQueue.push(sentence);
            pump();
        });
        streamDone = true;
        if (fullCollected) setCachedExplain(movie, persona, fullCollected);
        if (!sentenceQueue.length && !queueRunning) finishUp();
    } catch (err) {
        finishUp();
        appendExplainError();
    }
}

function appendExplainError() {
    showMovieError(t("explain_error"));
    setTimeout(() => {
        if (movieError.textContent === t("explain_error")) movieError.classList.add("hidden");
    }, 3000);
}

if (movieExplainBtn) {
    movieExplainBtn.addEventListener("click", () => explainMovie(state && state.currentMovie));
}

// Per-card variant used by the small "Explain" icon on browse/trending grid
// cards — same Gemini + speech-synthesis flow as explainMovie(), but tracks
// its loading/speaking state on the individual card button instead of the
// single global movieExplainBtn.
let browseExplainBusy = false;

async function explainBrowseCard(movie, btnEl) {
    if (!movie || !btnEl) return;
    if (!("speechSynthesis" in window)) return;

    if (browseExplainBusy) {
        window.speechSynthesis.cancel();
        browseExplainBusy = false;
        document.querySelectorAll(".browse-card-explain-btn.is-loading, .browse-card-explain-btn.is-speaking")
            .forEach((el) => el.classList.remove("is-loading", "is-speaking"));
        return;
    }

    browseExplainBusy = true;
    btnEl.classList.add("is-loading");

    try {
        const text = await callGeminiText(buildExplainPrompt(movie));
        if (!browseExplainBusy) return;

        const utterance = new SpeechSynthesisUtterance(text);
        const langCode = TMDB_LANG_MAP[currentLang] || "en-US";
        utterance.lang = langCode;
        const voice = pickVoiceForLang(langCode);
        if (voice) utterance.voice = voice;
        utterance.rate = 1;

        utterance.onstart = () => {
            btnEl.classList.remove("is-loading");
            btnEl.classList.add("is-speaking");
        };
        utterance.onend = () => {
            browseExplainBusy = false;
            btnEl.classList.remove("is-loading", "is-speaking");
        };
        utterance.onerror = () => {
            browseExplainBusy = false;
            btnEl.classList.remove("is-loading", "is-speaking");
        };

        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(utterance);
    } catch (err) {
        browseExplainBusy = false;
        btnEl.classList.remove("is-loading", "is-speaking");
    }
}

// -----------------------------------------------------------
// 15e. GOOGLE SIGN-IN (full-page redirect — no popup, no FedCM/One Tap)
// -----------------------------------------------------------
// Why this approach: Google's One Tap / popup flow depends on FedCM +
// third-party cookies, which browsers increasingly block by default
// (and can silently disable per-site after a dismissal). That makes the
// sign-in button do "nothing" with zero visible error. A plain OAuth
// redirect avoids all of that — clicking Sign In navigates the whole tab
// to Google's real sign-in screen, then Google redirects back here with
// the result in the URL. No popup window, no FedCM dependency.

function randomOauthState() {
    const bytes = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function googleRedirectUri() {
    return window.location.origin + window.location.pathname;
}

function buildGoogleAuthUrl(state) {
    const params = new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        redirect_uri: googleRedirectUri(),
        response_type: "token",
        scope: GOOGLE_OAUTH_SCOPE,
        include_granted_scopes: "true",
        prompt: "select_account",
        state
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

function signInWithGoogle() {
    if (!GOOGLE_CLIENT_ID || GOOGLE_CLIENT_ID.includes("YOUR_GOOGLE_CLIENT_ID")) {
        showMovieHomeToast("⚠️ Add your Google Client ID in script.js to enable sign-in.");
        return;
    }
    const state = randomOauthState();
    try {
        sessionStorage.setItem(GOOGLE_STATE_KEY, state);
    } catch (e) {}
    // Full-page navigation — this is the "screen" that appears instead of
    // a popup window.
    window.location.href = buildGoogleAuthUrl(state);
}

// Runs on every page load. If we just came back from Google's redirect,
// the access token is in the URL fragment (#access_token=...). We verify
// the state, fetch the profile, store the session, then clean the URL.
async function handleGoogleAuthRedirect() {
    if (!window.location.hash || window.location.hash.indexOf("access_token=") === -1) {
        // Not a sign-in redirect. Also surface any error Google sent back
        // (e.g. user cancelled) so the button doesn't feel "dead".
        if (window.location.hash && window.location.hash.indexOf("error=") !== -1) {
            const errParams = new URLSearchParams(window.location.hash.slice(1));
            const reason = errParams.get("error");
            if (reason && reason !== "access_denied") {
                showMovieHomeToast("⚠️ Google sign-in failed: " + reason);
            }
            history.replaceState(null, "", window.location.pathname + window.location.search);
        }
        return false;
    }

    const hashParams = new URLSearchParams(window.location.hash.slice(1));
    const accessToken = hashParams.get("access_token");
    const returnedState = hashParams.get("state");

    let expectedState = null;
    try {
        expectedState = sessionStorage.getItem(GOOGLE_STATE_KEY);
        sessionStorage.removeItem(GOOGLE_STATE_KEY);
    } catch (e) {}

    // Always strip the token out of the visible URL immediately, whether
    // or not it validates, so it's never left sitting in the address bar.
    history.replaceState(null, "", window.location.pathname + window.location.search);

    if (!expectedState || returnedState !== expectedState) {
        showMovieHomeToast("⚠️ Sign-in could not be verified. Please try again.");
        return false;
    }

    try {
        const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
            headers: { Authorization: "Bearer " + accessToken }
        });
        if (!res.ok) throw new Error("userinfo request failed");
        const profile = await res.json();
        currentUser = {
            sub: profile.sub,
            name: profile.name || profile.email || "Movie Fan",
            email: profile.email || "",
            picture: profile.picture || ""
        };
        try {
            localStorage.setItem(USER_SESSION_KEY, JSON.stringify(currentUser));
        } catch (e) {}
        renderAccountUI();
        updateWishlistCountBadge();
        return true;
    } catch (e) {
        showMovieHomeToast("⚠️ Couldn't complete Google sign-in. Please try again.");
        return false;
    }
}

function restoreSavedGoogleSession() {
    try {
        const saved = localStorage.getItem(USER_SESSION_KEY);
        if (saved) {
            currentUser = JSON.parse(saved);
            renderAccountUI();
            updateWishlistCountBadge();
        }
    } catch (e) {}
}

function signOutUser() {
    currentUser = null;
    try {
        localStorage.removeItem(USER_SESSION_KEY);
    } catch (e) {}
    renderAccountUI();
    updateWishlistCountBadge();
    if (userDropdown) userDropdown.classList.add("hidden");
}

function renderAccountUI() {
    if (currentUser) {
        if (googleSigninBtn) googleSigninBtn.classList.add("hidden");
        if (userMenuWrap) userMenuWrap.classList.remove("hidden");
        if (userAvatarImg) userAvatarImg.src = currentUser.picture || PLACEHOLDER_POSTER;
        if (userDropdownName) userDropdownName.textContent = currentUser.name || "";
        if (userDropdownEmail) userDropdownEmail.textContent = currentUser.email || "";
    } else {
        if (googleSigninBtn) googleSigninBtn.classList.remove("hidden");
        if (userMenuWrap) userMenuWrap.classList.add("hidden");
    }
    // Account changed (sign-in / switch / sign-out) — the "Continue with"
    // chip is per-account, so re-check it against the newly active user.
    renderResumeChip();
}

// Small reusable toast for account/wishlist feedback — reuses the existing
// share-toast element and styling instead of introducing a new pattern.
function showMovieHomeToast(message) {
    if (!shareToast) return;
    shareToast.textContent = message;
    shareToast.classList.remove("hidden");
    clearTimeout(showMovieHomeToast._t);
    showMovieHomeToast._t = setTimeout(() => shareToast.classList.add("hidden"), 2600);
}

if (googleSigninBtn) googleSigninBtn.addEventListener("click", signInWithGoogle);
if (userAvatarBtn) {
    userAvatarBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        userDropdown.classList.toggle("hidden");
    });
}
document.addEventListener("click", (e) => {
    if (userDropdown && !userDropdown.classList.contains("hidden") && !userMenuWrap.contains(e.target)) {
        userDropdown.classList.add("hidden");
    }
});
if (userSignOutBtn) userSignOutBtn.addEventListener("click", signOutUser);
if (userDropdownWishlistBtn) {
    userDropdownWishlistBtn.addEventListener("click", () => {
        userDropdown.classList.add("hidden");
        openBrowseScreen("wishlist");
    });
}

// -----------------------------------------------------------
// 15f. WISHLIST (per Google account, stored locally on this device)
// -----------------------------------------------------------
function getWishlist() {
    const key = wishlistStorageKey();
    if (!key) return [];
    try {
        return JSON.parse(localStorage.getItem(key) || "[]");
    } catch (e) {
        return [];
    }
}

function saveWishlist(list) {
    const key = wishlistStorageKey();
    if (!key) return;
    try {
        localStorage.setItem(key, JSON.stringify(list));
    } catch (e) {}
}

function isInWishlist(movieId) {
    return getWishlist().some((m) => m.id === movieId);
}

function updateWishlistCountBadge() {
    if (!wishlistCountBadge) return;
    const count = currentUser ? getWishlist().length : 0;
    wishlistCountBadge.textContent = String(count);
    wishlistCountBadge.classList.toggle("hidden", count === 0);
}

// Toggles a movie in/out of the wishlist and updates any button(s) passed
// in to reflect the new state. Requires sign-in — nudges the user to sign
// in with Google rather than silently failing.
function toggleWishlist(movie, ...btnEls) {
    hapticFeedback(10);
    if (!currentUser) {
        showMovieHomeToast(t("wishlist_signin_required"));
        signInWithGoogle();
        return;
    }
    const list = getWishlist();
    const idx = list.findIndex((m) => m.id === movie.id);
    let nowSaved;
    if (idx >= 0) {
        list.splice(idx, 1);
        nowSaved = false;
    } else {
        list.unshift({
            id: movie.id,
            title: movie.title || "",
            poster_path: movie.poster_path || "",
            vote_average: movie.vote_average || 0,
            release_date: movie.release_date || "",
            overview: movie.overview || "",
            genre_ids: movie.genre_ids || []
        });
        nowSaved = true;
    }
    saveWishlist(list);
    updateWishlistCountBadge();
    showMovieHomeToast(nowSaved ? t("wishlist_saved_toast") : t("wishlist_removed_toast"));
    btnEls.forEach((btn) => {
        if (btn) btn.classList.toggle("is-saved", nowSaved);
    });
}

if (movieWishlistBtn) {
    movieWishlistBtn.addEventListener("click", () => {
        if (state && state.currentMovie) toggleWishlist(state.currentMovie, movieWishlistBtn);
    });
}
if (wishlistBtn) wishlistBtn.addEventListener("click", () => openBrowseScreen("wishlist"));

// -----------------------------------------------------------
// 15g. HOMESCREEN ENHANCEMENTS
// -----------------------------------------------------------
function setHomeGreeting() {
    if (!startSubtitleEl) return;
    const hour = new Date().getHours();
    let key;
    if (hour >= 5 && hour < 12) key = "greeting_morning";
    else if (hour >= 12 && hour < 17) key = "greeting_afternoon";
    else if (hour >= 17 && hour < 22) key = "greeting_evening";
    else key = "greeting_night";
    startSubtitleEl.textContent = t(key);
}

function renderResumeChip() {
    if (!resumeChip) return;
    let last = null;
    try {
        last = JSON.parse(localStorage.getItem(lastMovieStorageKey()) || "null");
    } catch (e) {}
    if (!last || !last.id) {
        resumeChip.classList.add("hidden");
        return;
    }
    resumeChipPoster.src = last.poster_path ? `${TMDB_IMG_URL}${last.poster_path}` : PLACEHOLDER_POSTER;
    resumeChipTitle.textContent = last.title || "";
    resumeChip.classList.remove("hidden");
    resumeChip.onclick = () => loadSharedMovie(last.id);
}

function rememberLastMovie(movie) {
    if (!movie || !movie.id) return;
    try {
        localStorage.setItem(
            lastMovieStorageKey(),
            JSON.stringify({ id: movie.id, title: movie.title || "", poster_path: movie.poster_path || "" })
        );
    } catch (e) {}
}

async function renderHomeTrendingStrip() {
    if (!homeTrendingStrip || !homeTrendingSection) return;
    try {
        const langParam = TMDB_LANG_MAP[currentLang] || "en-US";
        const url = `${TMDB_BASE_URL}/trending/movie/week?api_key=${TMDB_API_KEY}&language=${langParam}&page=1`;
        const data = await cachedFetchJson(url);
        const movies = (data.results || []).slice(0, 12);
        if (!movies.length) return;

        homeTrendingStrip.innerHTML = "";
        const frag = document.createDocumentFragment();
        movies.forEach((movie) => {
            const item = document.createElement("div");
            item.className = "home-trending-item";
            const posterPath = movie.poster_path ? `${TMDB_IMG_URL}${movie.poster_path}` : PLACEHOLDER_POSTER;
            item.innerHTML = `<img src="${posterPath}" alt="${movie.title || ''}" loading="lazy">`;
            item.addEventListener("click", () => loadSharedMovie(movie.id));
            frag.appendChild(item);
        });
        homeTrendingStrip.appendChild(frag);
        homeTrendingSection.classList.remove("hidden");
    } catch (e) {
        // Fail silently on the homescreen — this is a nice-to-have teaser,
        // not core functionality, so we don't want to show an error state.
    }
}

if (homeQuickChips) {
    homeQuickChips.addEventListener("click", (e) => {
        const chip = e.target.closest(".home-chip");
        if (!chip) return;
        const mode = chip.dataset.mode;
        if (mode === "theaters") {
            theatersBtnHandler();
        } else {
            openBrowseScreen(mode);
        }
    });
}

function initHomescreen() {
    setHomeGreeting();
    renderResumeChip();
    renderHomeTrendingStrip();
    if (homeTrendingHeadingEl) homeTrendingHeadingEl.textContent = t("home_trending_heading");
    document.querySelectorAll(".home-chip").forEach((chip) => {
        const mode = chip.dataset.mode;
        if (mode) chip.textContent = t(`chip_${mode}`);
    });
    renderRecentlyViewedRail();
    renderOttChips();
    if (moodInput) moodInput.placeholder = t("mood_placeholder");
    if (moodSubmitBtn) moodSubmitBtn.textContent = t("mood_submit_btn");
    if (homeRecentHeadingEl) homeRecentHeadingEl.textContent = t("recent_heading");
    if (ottSelectHeading) ottSelectHeading.textContent = t("ott_heading");
    if (spoilerToggleLabel) spoilerToggleLabel.textContent = t("spoiler_toggle_label");
}

// =========================================================
// PHASE 2 ENHANCEMENTS
// =========================================================

// --- Haptic feedback (mobile) ---
function hapticFeedback(pattern) {
    try {
        if (navigator.vibrate) navigator.vibrate(pattern);
    } catch (e) {}
}

// --- Cinema / Dim mode toggle ---
(function setupCinemaMode() {
    if (!cinemaModeBtn) return;
    let active = false;
    try { active = localStorage.getItem("popcornnight_cinema_mode") === "1"; } catch (e) {}
    function apply() {
        document.body.classList.toggle("cinema-mode", active);
        cinemaModeBtn.classList.toggle("active", active);
        if (cinemaModeOverlay) cinemaModeOverlay.classList.toggle("active", active);
    }
    apply();
    cinemaModeBtn.addEventListener("click", () => {
        active = !active;
        apply();
        hapticFeedback(8);
        try { localStorage.setItem("popcornnight_cinema_mode", active ? "1" : "0"); } catch (e) {}
    });
})();

// --- Dynamic poster-as-color-theme (Canvas dominant color extraction) ---
function extractPosterAccentColor(imgEl, wrapEl) {
    if (!imgEl || !wrapEl) return;
    wrapEl.classList.remove("has-accent");
    if (revealBackdrop) revealBackdrop.classList.remove("has-accent");

    const run = () => {
        try {
            const canvas = document.createElement("canvas");
            const w = (canvas.width = 24);
            const h = (canvas.height = 34);
            const ctx = canvas.getContext("2d");
            ctx.drawImage(imgEl, 0, 0, w, h);
            const data = ctx.getImageData(0, 0, w, h).data;
            let r = 0, g = 0, b = 0, count = 0;
            for (let i = 0; i < data.length; i += 4) {
                const alpha = data[i + 3];
                if (alpha < 100) continue;
                const rr = data[i], gg = data[i + 1], bb = data[i + 2];
                // Skip near-black/near-white pixels which tend to be letterboxing.
                const lum = (rr + gg + bb) / 3;
                if (lum < 18 || lum > 240) continue;
                r += rr; g += gg; b += bb; count++;
            }
            if (!count) return;
            r = Math.round(r / count); g = Math.round(g / count); b = Math.round(b / count);
            // Boost saturation a touch so the glow reads as vibrant, not muddy.
            const accent = `rgb(${r}, ${g}, ${b})`;
            wrapEl.style.setProperty("--poster-accent", accent);
            wrapEl.classList.add("has-accent");
            if (revealBackdrop) revealBackdrop.classList.add("has-accent");
        } catch (e) {
            // Canvas tainted by cross-origin image (CORS) — silently skip, the
            // rest of the UI still works fine without the dynamic accent.
        }
    };

    if (imgEl.complete && imgEl.naturalWidth) {
        run();
    } else {
        imgEl.addEventListener("load", run, { once: true });
    }
}

// --- Why-You'll-Like-This badge (based on wishlist genre overlap) ---
function renderWhyYoullLikeBadge(movie) {
    if (!whyYoullLikeBadge) return;
    whyYoullLikeBadge.classList.add("hidden");
    if (!currentUser) return;
    const wishlist = getWishlist();
    if (!wishlist.length || !movie.genre_ids || !movie.genre_ids.length) return;

    const genreCounts = new Map();
    wishlist.forEach((m) => (m.genre_ids || []).forEach((id) => genreCounts.set(id, (genreCounts.get(id) || 0) + 1)));

    let bestGenre = null, bestCount = 0;
    movie.genre_ids.forEach((id) => {
        const c = genreCounts.get(id) || 0;
        if (c > bestCount) { bestCount = c; bestGenre = id; }
    });
    if (!bestGenre || bestCount === 0) return;

    const meta = genreLabel(bestGenre);
    const exampleTitle = wishlist.find((m) => (m.genre_ids || []).includes(bestGenre))?.title;
    if (!meta || !exampleTitle) return;

    whyYoullLikeBadge.textContent = `${t("why_youll_like_prefix")} ${exampleTitle} (${meta.icon} ${meta.label})`;
    whyYoullLikeBadge.classList.remove("hidden");
}

// --- Recently Viewed rail ---
const RECENT_KEY = "popcornnight_recently_viewed";
const RECENT_MAX = 12;

function getRecentlyViewed() {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); } catch (e) { return []; }
}

function addToRecentlyViewed(movie) {
    if (!movie || !movie.id) return;
    let list = getRecentlyViewed();
    list = list.filter((m) => m.id !== movie.id);
    list.unshift({
        id: movie.id,
        title: movie.title || "",
        poster_path: movie.poster_path || "",
        vote_average: movie.vote_average || 0,
        genre_ids: movie.genre_ids || []
    });
    list = list.slice(0, RECENT_MAX);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch (e) {}
}

function renderRecentlyViewedRail() {
    if (!homeRecentStrip || !homeRecentSection) return;
    const list = getRecentlyViewed();
    if (!list.length) {
        homeRecentSection.classList.add("hidden");
        return;
    }
    homeRecentStrip.innerHTML = "";
    const frag = document.createDocumentFragment();
    list.forEach((movie) => {
        const item = document.createElement("div");
        item.className = "home-trending-item";
        const posterPath = movie.poster_path ? `${TMDB_IMG_URL}${movie.poster_path}` : PLACEHOLDER_POSTER;
        item.innerHTML = `<img src="${posterPath}" alt="${movie.title}" loading="lazy">`;
        item.addEventListener("click", () => loadSharedMovie(movie.id));
        frag.appendChild(item);
    });
    homeRecentStrip.appendChild(frag);
    homeRecentSection.classList.remove("hidden");
}

// --- Mood-to-Movie one-liner (skips the quiz entirely) ---
async function handleMoodSubmit() {
    const text = moodInput && moodInput.value.trim();
    if (!text) return;
    if (moodError) moodError.classList.add("hidden");
    hapticFeedback(10);
    if (moodSubmitBtn) { moodSubmitBtn.disabled = true; moodSubmitBtn.textContent = "..."; }

    try {
        const langLabel = currentLang === "hi" ? "Hindi, written in the Devanagari script (हिंदी)" : "English";
        const prompt = `A user typed this free-form mood/craving into a movie app called PopcornNight: "${text}"

Based on this mood, recommend movies for tonight — skip any quiz, go straight to picks.

Reply with ONLY strict JSON (no markdown, no commentary) matching EXACTLY this shape:
{"type":"recommendation","movies":[{"title":"<exact real movie title>","year":<release year as a number>,"reason":"<one short, punchy sentence on why it fits the mood, in ${langLabel}>"}]}
- Include EXACTLY 6 real, existing movies, ordered best match first.
- Never invent a movie — only recommend titles you're confident actually exist.
- Every "reason" must be written entirely in ${langLabel}.`;
        const parsed = await callGemini(prompt);

        if (!parsed || !Array.isArray(parsed.movies) || !parsed.movies.length) {
            throw new Error("mood-no-movies");
        }

        state = freshState();
        state.isAiMode = true;
        state.aiHistory = [{ question: "What are you in the mood for tonight?", answer: text }];
        state.aiRecommendations = parsed.movies;

        goToReveal();
    } catch (err) {
        if (moodError) {
            moodError.textContent = t("mood_error");
            moodError.classList.remove("hidden");
        }
    } finally {
        if (moodSubmitBtn) { moodSubmitBtn.disabled = false; moodSubmitBtn.textContent = t("mood_submit_btn"); }
    }
}

if (moodSubmitBtn) moodSubmitBtn.addEventListener("click", handleMoodSubmit);
if (moodInput) {
    moodInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") handleMoodSubmit();
    });
}

// --- OTT-aware filtering (subscription chip selector) ---
const OTT_PROVIDERS = [
    { id: 8, name: "Netflix" },
    { id: 119, name: "Prime Video" },
    { id: 122, name: "Hotstar" },
    { id: 337, name: "Disney+" },
    { id: 350, name: "Apple TV+" }
];
const OTT_KEY = "popcornnight_ott_subs";

function getSelectedOtt() {
    try { return JSON.parse(localStorage.getItem(OTT_KEY) || "[]"); } catch (e) { return []; }
}
function setSelectedOtt(ids) {
    try { localStorage.setItem(OTT_KEY, JSON.stringify(ids)); } catch (e) {}
}

function renderOttChips() {
    if (!ottChipRow) return;
    const selected = new Set(getSelectedOtt());
    ottChipRow.innerHTML = "";
    OTT_PROVIDERS.forEach((p) => {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "ott-chip" + (selected.has(p.id) ? " selected" : "");
        chip.textContent = p.name;
        chip.addEventListener("click", () => {
            const current = new Set(getSelectedOtt());
            if (current.has(p.id)) current.delete(p.id); else current.add(p.id);
            setSelectedOtt([...current]);
            chip.classList.toggle("selected");
            hapticFeedback(6);
        });
        ottChipRow.appendChild(chip);
    });
}

// Highlights streaming pills that match the user's selected subscriptions —
// called from loadMovieExtras() after platform pills are built.
function markOwnedPlatforms(container) {
    const selected = new Set(getSelectedOtt());
    if (!selected.size || !container) return;
    container.querySelectorAll(".platform-pill").forEach((pill) => {
        const img = pill.querySelector("img");
        if (!img) return;
        // We don't have the provider id on the pill DOM, so match loosely by
        // logo URL id isn't available — instead match by visible name text.
        const nameEl = pill.querySelector("span:last-child");
        const name = nameEl ? nameEl.textContent : "";
        const owned = OTT_PROVIDERS.some((p) => selected.has(p.id) && name.toLowerCase().includes(p.name.toLowerCase().split(" ")[0].toLowerCase()));
        if (owned) pill.classList.add("on-your-service");
    });
}

// --- Affiliate ticket link (BookMyShow-style deep link for in-theaters picks) ---
function updateAffiliateTicketLink(movie) {
    if (!ticketAffiliateLink) return;
    if (!movie || !movie.release_date) {
        ticketAffiliateLink.classList.add("hidden");
        return;
    }
    const releaseDate = new Date(movie.release_date);
    const daysSinceRelease = (Date.now() - releaseDate.getTime()) / 86400000;
    // Only show for movies that released recently or are upcoming — i.e.
    // plausibly still in theaters.
    if (isNaN(daysSinceRelease) || daysSinceRelease > 45 || daysSinceRelease < -60) {
        ticketAffiliateLink.classList.add("hidden");
        return;
    }
    const query = encodeURIComponent(movie.title || "");
    // Affiliate/tracking id placeholder — swap in a real BookMyShow (or local
    // ticketing partner) affiliate id here once you have one.
    ticketAffiliateLink.href = `https://in.bookmyshow.com/explore/movies?q=${query}&utm_source=popcornnight&utm_medium=affiliate`;
    ticketAffiliateLink.textContent = t("ticket_affiliate_btn");
    ticketAffiliateLink.classList.remove("hidden");
}

// --- Persona/spoiler labels refresh on language change is handled by
//     applyStaticTranslations() calling initHomescreen()/rerenders elsewhere.

// --- Voice input (SpeechRecognition) for the chat box ---
(function setupVoiceInput() {
    if (!movieChatMicBtn) return;
    const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionAPI) {
        movieChatMicBtn.classList.add("hidden");
        return;
    }
    let recognition = null;
    let listening = false;

    function getRecognizer() {
        if (recognition) return recognition;
        recognition = new SpeechRecognitionAPI();
        recognition.continuous = false;
        recognition.interimResults = false;
        recognition.maxAlternatives = 1;
        recognition.onresult = (e) => {
            const transcript = e.results[0][0].transcript;
            if (movieChatInput) movieChatInput.value = transcript;
        };
        recognition.onend = () => {
            listening = false;
            movieChatMicBtn.classList.remove("is-listening");
            const val = movieChatInput && movieChatInput.value.trim();
            if (val) sendChatMessage(val).then(() => { if (movieChatInput) movieChatInput.value = ""; });
        };
        recognition.onerror = () => {
            listening = false;
            movieChatMicBtn.classList.remove("is-listening");
        };
        return recognition;
    }

    movieChatMicBtn.addEventListener("click", () => {
        const rec = getRecognizer();
        rec.lang = TMDB_LANG_MAP[currentLang] || "en-US";
        if (listening) {
            rec.stop();
            listening = false;
            movieChatMicBtn.classList.remove("is-listening");
            return;
        }
        try {
            rec.start();
            listening = true;
            hapticFeedback(10);
            movieChatMicBtn.classList.add("is-listening");
        } catch (e) {}
    });
})();

// --- Persona toggle inside chat modal is separate from Explain persona —
//     keep both button groups in sync since they represent the same setting.
if (personaEli5Btn && personaCriticBtn) {
    // already wired above near explainMovie(); nothing further needed here.
}

// --- Movie Comparison Engine (dedicated modal, feeds the chat) ---
if (compareModeBtn) {
    compareModeBtn.addEventListener("click", () => {
        if (!chatMovieContext) return;
        if (compareCurrentTitle) compareCurrentTitle.textContent = chatMovieContext.title || "";
        if (compareInput) compareInput.value = "";
        compareModal.classList.remove("hidden");
        setTimeout(() => compareInput && compareInput.focus(), 150);
    });
}
if (compareModalClose) compareModalClose.addEventListener("click", () => compareModal.classList.add("hidden"));
if (compareModalBackdrop) compareModalBackdrop.addEventListener("click", () => compareModal.classList.add("hidden"));
if (compareSubmitBtn) {
    compareSubmitBtn.addEventListener("click", () => {
        const other = compareInput && compareInput.value.trim();
        if (!other || !chatMovieContext) return;
        compareModal.classList.add("hidden");
        const question = `Should I watch "${chatMovieContext.title}" or "${other}" tonight? Compare them.`;
        if (movieChatModal.classList.contains("hidden")) openMovieChat(chatMovieContext);
        sendChatMessage(question);
    });
}

// --- PWA: notification permission toggle (local demo notification; a real
//     push backend would be required for true server-sent push) ---
if (notifToggleInput) {
    try { notifToggleInput.checked = localStorage.getItem("popcornnight_notif") === "1" && Notification.permission === "granted"; } catch (e) {}
    notifToggleInput.addEventListener("change", async () => {
        if (notifToggleInput.checked) {
            try {
                const perm = await Notification.requestPermission();
                if (perm === "granted") {
                    try { localStorage.setItem("popcornnight_notif", "1"); } catch (e) {}
                    showToast(t("notif_enabled_toast"));
                    new Notification("PopcornNight 🍿", { body: "You're all set — we'll let you know about picks worth seeing." });
                } else {
                    notifToggleInput.checked = false;
                }
            } catch (e) {
                notifToggleInput.checked = false;
            }
        } else {
            try { localStorage.setItem("popcornnight_notif", "0"); } catch (e) {}
        }
    });
}

// --- Offline detection toast ---
window.addEventListener("offline", () => showToast(t("offline_toast")));

// Lightweight TMDB title search that RETURNS results (unlike performSearch(),
// which renders straight into the search-panel UI) — used by features like
// Watch Party that need the raw match data instead.
async function searchMovieByTitle(title) {
    try {
        const langParam = TMDB_LANG_MAP[currentLang] || "en-US";
        const url = `${TMDB_BASE_URL}/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(title)}&language=${langParam}&include_adult=false&page=1`;
        const data = await cachedFetchJson(url);
        return (data && data.results) || [];
    } catch (e) {
        return [];
    }
}

// --- Watch Party Mode (same-device, two-player taste merge) ---
(function setupWatchParty() {
    if (!chipWatchparty) return;
    const PARTY_QUESTIONS = [
        { key: "genre", title: "Pick a genre", options: ["Action", "Comedy", "Romance", "Horror", "Thriller", "Drama"] },
        { key: "mood", title: "Tonight's mood", options: ["Laugh 😂", "Cry 😭", "Thrill 😱", "Chill 😌"] },
        { key: "era", title: "Any era preference?", options: ["Latest", "2010s", "2000s", "Classics", "No preference"] }
    ];
    let currentPlayer = 1;
    let answersA = {};
    let answersB = {};
    let roomCode = "";

    function genRoomCode() {
        return Math.random().toString(36).slice(2, 8).toUpperCase();
    }

    function renderQuestions(answersRef) {
        watchpartyQuestions.innerHTML = "";
        PARTY_QUESTIONS.forEach((q) => {
            const block = document.createElement("div");
            block.className = "watchparty-question-block";
            const title = document.createElement("div");
            title.className = "watchparty-question-title";
            title.textContent = q.title;
            block.appendChild(title);
            const row = document.createElement("div");
            row.className = "watchparty-option-row";
            q.options.forEach((opt) => {
                const btn = document.createElement("button");
                btn.type = "button";
                btn.className = "watchparty-option" + (answersRef[q.key] === opt ? " selected" : "");
                btn.textContent = opt;
                btn.addEventListener("click", () => {
                    answersRef[q.key] = opt;
                    row.querySelectorAll(".watchparty-option").forEach((b) => b.classList.remove("selected"));
                    btn.classList.add("selected");
                    hapticFeedback(6);
                });
                row.appendChild(btn);
            });
            block.appendChild(row);
            watchpartyQuestions.appendChild(block);
        });
    }

    function openParty() {
        roomCode = genRoomCode();
        watchpartyRoomCode.textContent = roomCode;
        currentPlayer = 1;
        answersA = {};
        answersB = {};
        watchpartySetup.classList.remove("hidden");
        watchpartyResult.classList.add("hidden");
        watchpartyNextBtn.textContent = t("watchparty_continue_btn");
        renderQuestions(answersA);
        watchpartyModal.classList.remove("hidden");
    }

    async function finishParty() {
        watchpartySetup.classList.add("hidden");
        watchpartyResult.classList.remove("hidden");
        watchpartyResult.textContent = t("watchparty_finding");
        try {
            const prompt = `Two friends are picking a movie together tonight. Their quick taste answers:
Player 1: ${JSON.stringify(answersA)}
Player 2: ${JSON.stringify(answersB)}

Suggest ONE well-known real movie both would likely enjoy, blending their tastes (compromise where they differ). Reply with ONLY a JSON object: {"title": "movie title", "reason": "one short sentence explaining the pick, in ${currentLang === "hi" ? "Hindi" : "English"}"}`;
            const parsed = await callGemini(prompt);
            const results = await searchMovieByTitle(parsed.title);
            watchpartyResult.innerHTML = "";
            const p = document.createElement("p");
            p.textContent = `🎬 ${parsed.title} — ${parsed.reason || ""}`;
            watchpartyResult.appendChild(p);
            if (results && results.length) {
                const btn = document.createElement("button");
                btn.className = "btn ticket-btn watchparty-next-btn";
                btn.textContent = "🍿 Watch This";
                btn.addEventListener("click", () => {
                    watchpartyModal.classList.add("hidden");
                    loadSharedMovie(results[0].id);
                });
                watchpartyResult.appendChild(btn);
            }
        } catch (e) {
            watchpartyResult.textContent = t("chat_error");
        }
    }

    watchpartyNextBtn.addEventListener("click", () => {
        if (currentPlayer === 1) {
            currentPlayer = 2;
            renderQuestions(answersB);
        } else {
            finishParty();
        }
    });

    chipWatchparty.addEventListener("click", openParty);
    if (watchpartyModalClose) watchpartyModalClose.addEventListener("click", () => watchpartyModal.classList.add("hidden"));
    if (watchpartyModalBackdrop) watchpartyModalBackdrop.addEventListener("click", () => watchpartyModal.classList.add("hidden"));
    if (watchpartyCopyBtn) {
        watchpartyCopyBtn.addEventListener("click", async () => {
            const url = `${window.location.origin}${window.location.pathname}?party=${roomCode}`;
            try {
                await navigator.clipboard.writeText(url);
                showToast(t("share_copied"));
            } catch (e) {
                window.prompt("Copy this link:", url);
            }
        });
    }
})();

// -----------------------------------------------------------
// 16. SHARE
// -----------------------------------------------------------
let toastTimer = null;

function showToast(message) {
    shareToast.textContent = message;
    shareToast.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => shareToast.classList.add("hidden"), 2200);
}

function buildShareUrl() {
    const url = new URL(window.location.href);
    if (state && state.currentMovie) {
        url.searchParams.set("movie", state.currentMovie.id);
    }
    url.searchParams.set("lang", currentLang);
    return url.toString();
}

async function copyShareLink() {
    const url = buildShareUrl();
    try {
        await navigator.clipboard.writeText(url);
        showToast(t("share_copied"));
    } catch (err) {
        window.prompt("Copy this link:", url);
    }
}

function openShareMenu() {
    if (!state || !state.currentMovie) return;
    shareMenu.classList.remove("hidden");
}

function closeShareMenu() {
    shareMenu.classList.add("hidden");
}

shareBtn.addEventListener("click", openShareMenu);
shareMenuBackdrop.addEventListener("click", closeShareMenu);

shareWhatsappBtn.addEventListener("click", () => {
    const title = movieTitle.textContent || "this movie";
    const text = encodeURIComponent(`🎬 Check out "${title}" — ${buildShareUrl()}`);
    window.open(`https://wa.me/?text=${text}`, "_blank", "noopener");
    closeShareMenu();
});

shareInstagramBtn.addEventListener("click", async () => {
    // Instagram doesn't support pre-filled share links on the web, so we
    // copy the link and hand off to the Instagram app/site to paste into a story/DM.
    await copyShareLink();
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (isMobile) {
        window.location.href = "instagram://app";
        setTimeout(() => {
            window.open("https://www.instagram.com/", "_blank", "noopener");
        }, 700);
    } else {
        window.open("https://www.instagram.com/", "_blank", "noopener");
    }
    closeShareMenu();
});

shareCopyBtn.addEventListener("click", async () => {
    await copyShareLink();
    closeShareMenu();
});

// -----------------------------------------------------------
// 17. DIRECT SHARED-LINK VIEW
// -----------------------------------------------------------
async function loadSharedMovie(movieId) {
    state = freshState();
    showScreen(revealScreen);
    clapperboardContainer.classList.add("hidden");
    movieResult.classList.remove("hidden");
    broadenBtn.classList.add("hidden");

    try {
        const langParam = TMDB_LANG_MAP[currentLang] || "en-US";
        const url = `${TMDB_BASE_URL}/movie/${movieId}?api_key=${TMDB_API_KEY}&language=${langParam}`;
        const details = await cachedFetchJson(url);
        const movieLike = {
            id: details.id,
            title: details.title,
            overview: details.overview,
            poster_path: details.poster_path,
            backdrop_path: details.backdrop_path,
            vote_average: details.vote_average,
            release_date: details.release_date,
            genre_ids: (details.genres || []).map((g) => g.id),
            popularity: details.popularity || 0
        };
        state.currentMovie = movieLike;
        renderMovie(movieLike);
        loadMovieExtras(movieLike.id);
    } catch (err) {
        showMovieError(t("error_network"));
    }
}

// -----------------------------------------------------------
// 18. FILM REEL STRIP
// -----------------------------------------------------------
const FILM_REEL_TRACK = document.getElementById("film-reel-track");
const FILM_REEL_POSTER_COUNT = 14;

async function loadFilmReel() {
    if (!FILM_REEL_TRACK) return;

    let posterItems = FALLBACK_POSTERS.map((p) => ({ id: null, poster_path: p, title: "" }));

    if (TMDB_API_KEY && TMDB_API_KEY !== "YOUR_TMDB_API_KEY_HERE") {
        try {
            const randomPage = Math.floor(Math.random() * 20) + 1;
            const urls = [
                `${TMDB_BASE_URL}/movie/popular?api_key=${TMDB_API_KEY}&language=en-US&page=${randomPage}`,
                `${TMDB_BASE_URL}/trending/movie/week?api_key=${TMDB_API_KEY}&page=1`
            ];

            const responses = await Promise.allSettled(urls.map((url) => cachedFetchJson(url)));

            const fetchedItems = [];
            responses.forEach((res) => {
                if (res.status === "fulfilled") {
                    const results = res.value.results || [];
                    results
                        .filter((m) => m.poster_path && !m.poster_path.includes("data:"))
                        .forEach((m) => fetchedItems.push({ id: m.id, poster_path: m.poster_path, title: m.title || m.name || "" }));
                }
            });

            if (fetchedItems.length) {
                const byPath = new Map();
                [...fetchedItems, ...posterItems].forEach((item) => {
                    if (!byPath.has(item.poster_path)) byPath.set(item.poster_path, item);
                });
                posterItems = [...byPath.values()];
            }
        } catch (err) {}
    }

    posterItems = posterItems.sort(() => Math.random() - 0.5);
    renderFilmReel(posterItems.slice(0, FILM_REEL_POSTER_COUNT));
    renderPosterRails(posterItems.slice(FILM_REEL_POSTER_COUNT, FILM_REEL_POSTER_COUNT + 24));
    startMobileHeroBackdrop(posterItems);
}

// --- Responsive hero background: on mobile/tablet (where the desktop-only
//     side poster rails are hidden), slow-crossfade blurred posters behind
//     the homescreen instead, so the "movie vibes" ambience isn't desktop-only.
function startMobileHeroBackdrop(posterItems) {
    const a = document.getElementById("mobile-hero-backdrop-a");
    const b = document.getElementById("mobile-hero-backdrop-b");
    if (!a || !b || !posterItems.length) return;
    const usable = posterItems.filter((p) => p.poster_path);
    if (!usable.length) return;

    let idx = 0;
    let showingA = true;

    function urlFor(item) {
        const path = item.poster_path;
        return !path.startsWith("http") && !path.startsWith("data:") ? `${TMDB_IMG_URL}${path}` : path;
    }

    function tick() {
        const item = usable[idx % usable.length];
        idx++;
        const showEl = showingA ? a : b;
        const hideEl = showingA ? b : a;
        showEl.style.backgroundImage = `url(${urlFor(item)})`;
        showEl.classList.add("visible");
        hideEl.classList.remove("visible");
        showingA = !showingA;
    }

    tick();
    setInterval(tick, 7000);
}

// Desktop-only decorative side rails (see .poster-rail in style.css). Reuses
// the poster list already fetched above so this costs no extra requests.
const POSTER_RAIL_LEFT = document.getElementById("poster-rail-left-track");
const POSTER_RAIL_RIGHT = document.getElementById("poster-rail-right-track");

function renderPosterRails(posterItems) {
    if ((!POSTER_RAIL_LEFT && !POSTER_RAIL_RIGHT) || !posterItems.length) return;

    const mid = Math.ceil(posterItems.length / 2);
    const leftSet = posterItems.slice(0, mid);
    const rightSet = posterItems.slice(mid);

    fillRailTrack(POSTER_RAIL_LEFT, leftSet);
    fillRailTrack(POSTER_RAIL_RIGHT, rightSet.length ? rightSet : leftSet);
}

function fillRailTrack(track, posterItems) {
    if (!track || !posterItems.length) return;
    track.innerHTML = "";
    const frag = document.createDocumentFragment();

    // Duplicate the list so the CSS translateY(-50%) loop is seamless.
    [...posterItems, ...posterItems].forEach((item) => {
        const wrap = document.createElement("div");
        wrap.className = "rail-poster";
        const img = document.createElement("img");

        const path = item.poster_path;
        let src = path;
        if (!path.startsWith("http") && !path.startsWith("data:")) {
            src = `${TMDB_IMG_URL}${path}`;
        }
        img.src = src;
        img.alt = item.title || "";
        img.loading = "eager";
        img.decoding = "async";
        img.onerror = () => wrap.remove();

        if (item.id) {
            wrap.classList.add("rail-poster-clickable");
            wrap.title = item.title || "";
            wrap.addEventListener("click", () => loadSharedMovie(item.id));
        }

        wrap.appendChild(img);
        frag.appendChild(wrap);
    });

    track.appendChild(frag);
}

function renderFilmReel(posterItems) {
    FILM_REEL_TRACK.innerHTML = "";
    const frag = document.createDocumentFragment();
    const loadPromises = [];

    [...posterItems, ...posterItems].forEach((item) => {
        const frame = document.createElement("div");
        frame.className = "reel-frame";
        const img = document.createElement("img");

        const path = item.poster_path;
        let src = path;
        if (!path.startsWith("http") && !path.startsWith("data:")) {
            src = `${TMDB_IMG_URL}${path}`;
        }

        img.src = src;
        img.alt = item.title || "";
        img.loading = "eager";
        img.decoding = "async";

        img.onerror = () => {
            frame.remove();
        };

        if (item.id) {
            frame.classList.add("reel-frame-clickable");
            frame.title = item.title || "";
            frame.addEventListener("click", () => loadSharedMovie(item.id));
        }

        // Track when each image has actually finished loading (or failed) so
        // we can wait for real layout/paint before kicking off the marquee —
        // starting it too early is what causes the animation to render
        // "stuck" on iOS Safari until something (like backgrounding and
        // foregrounding the app) forces a repaint.
        loadPromises.push(new Promise((resolve) => {
            img.addEventListener("load", resolve, { once: true });
            img.addEventListener("error", resolve, { once: true });
        }));

        frame.appendChild(img);
        frag.appendChild(frame);
    });

    FILM_REEL_TRACK.appendChild(frag);

    Promise.race([
        Promise.all(loadPromises),
        new Promise((resolve) => setTimeout(resolve, 1500))
    ]).then(() => {
        restartReelAnimation();
    });
}

// Forces the marquee animation to (re)start cleanly. iOS Safari has a known
// quirk where a CSS animation that begins before the page has a real, settled
// layout/paint can get stuck at its 0% frame — it silently "catches up" the
// next time the browser is forced to repaint (e.g. backgrounding and
// foregrounding the app, which is exactly the workaround users stumble on).
// Removing the animation, forcing a synchronous reflow, then re-applying it
// makes the browser treat it as a brand-new animation tied to the current
// (settled) layout, which reliably kicks it off without needing that manual
// repaint.
function restartReelAnimation() {
    if (!FILM_REEL_TRACK || !FILM_REEL_TRACK.children.length) return;
    FILM_REEL_TRACK.style.animation = "none";
    void FILM_REEL_TRACK.offsetWidth;
    FILM_REEL_TRACK.style.animation = "reelScroll 28s linear infinite";
}

// Self-healing fallbacks: if the very first start still gets stuck (this can
// happen if iOS defers work while the page is loading in the background),
// re-trigger it the moment the page is actually shown/visible/focused —
// covering every situation that used to require a manual minimize+maximize.
window.addEventListener("pageshow", restartReelAnimation);
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") restartReelAnimation();
});
window.addEventListener("focus", restartReelAnimation);

// Global top-left home event binder
if (homeBtn) {
    homeBtn.addEventListener("click", () => {
        if (window.history && window.history.replaceState) {
            const url = new URL(window.location.href);
            url.searchParams.delete("movie");
            window.history.replaceState({}, "", url);
        }
        showScreen(startScreen);
    });
}

// -----------------------------------------------------------
// 19. INIT
// -----------------------------------------------------------
(function init() {
    const params = new URLSearchParams(window.location.search);
    const sharedMovieId = params.get("movie");
    const sharedLang = params.get("lang");

    let storedLang = null;
    try {
        storedLang = localStorage.getItem("mmm_lang");
    } catch (err) {}

    if (sharedLang && TRANSLATIONS[sharedLang]) {
        currentLang = sharedLang;
    } else if (storedLang && TRANSLATIONS[storedLang]) {
        currentLang = storedLang;
    }
    langSelect.value = currentLang;
    applyStaticTranslations();
    populateLocationSelect();

    if (sharedMovieId) {
        loadSharedMovie(sharedMovieId);
    }

    loadFilmReel();

    // If we just landed back here from Google's sign-in redirect, finish
    // that flow first; otherwise just restore any previously saved session.
    handleGoogleAuthRedirect().then((didSignIn) => {
        if (!didSignIn) restoreSavedGoogleSession();
    });

    initHomescreen();
})();
const axios = require('axios');
require('dotenv').config();

const apiKey = process.env.VALORANT_API_KEY;
const name = 'J U S E S';
const tag = 'dino';
// Tracker.gg usually uses "riot" as platform and Name#Tag
const platformUserIdentifier = encodeURIComponent(`${name}#${tag}`);

async function testTrackerNetwork() {
    console.log(`Testing Tracker Network API for ${name}#${tag}...`);

    // Endpoint 1: Standard Profile (might contain recent matches)
    // https://public-api.tracker.gg/v2/valorant/standard/profile/riot/{identifier}
    const profileUrl = `https://public-api.tracker.gg/v2/valorant/standard/profile/riot/${platformUserIdentifier}`;

    console.log("\n--- Attempt 1: Profile Endpoint ---");
    console.log("URL:", profileUrl);

    try {
        const response = await axios.get(profileUrl, {
            headers: {
                'TRN-Api-Key': apiKey,
                'Accept': 'application/json'
            }
        });
        console.log("SUCCESS!");
        console.log("Status:", response.status);
        console.log("Data Keys:", Object.keys(response.data.data));
        // Check if matches are included
        if (response.data.data.segments) {
            console.log("Found Segments (Stats):", response.data.data.segments.length);
        }
    } catch (e) {
        console.log("Failed:", e.response ? e.response.status : e.message);
        if (e.response && e.response.status === 401) {
            console.log("Auth Error: Key might be invalid or missing TRN-Api-Key header.");
        }
        if (e.response && e.response.status === 403) {
            console.log("Forbidden: Key valid but maybe no access to this specific endpoint.");
        }
    }

    // Endpoint 2: Matches Endpoint (Common pattern)
    // https://public-api.tracker.gg/v2/valorant/standard/profile/riot/{identifier}/sessions or /matches
    const matchesUrl = `https://public-api.tracker.gg/v2/valorant/standard/profile/riot/${platformUserIdentifier}/matches`;
    console.log("\n--- Attempt 2: Matches Endpoint (Guess) ---");
    console.log("URL:", matchesUrl);

    try {
        const response = await axios.get(matchesUrl, {
            headers: {
                'TRN-Api-Key': apiKey,
                'Accept': 'application/json'
            }
        });
        console.log("SUCCESS!");
        console.log("Status:", response.status);
    } catch (e) {
        console.log("Failed:", e.response ? e.response.status : e.message);
    }
}

testTrackerNetwork();

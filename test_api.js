const axios = require('axios');
require('dotenv').config();

const apiKey = process.env.VALORANT_API_KEY;
const name = 'J U S E S ';
const tag = 'dino';
const region = 'ap';

async function testApi() {
    const url = `https://api.henrikdev.xyz/valorant/v3/matches/${region}/${name}/${tag}`;
    console.log(`Testing API for ${name}#${tag} in ${region}...`);
    console.log("URL:", url);

    // Attempt 1: Authorization Header
    console.log("\n--- Attempt 1: Authorization Header ---");
    try {
        const response = await axios.get(url, { headers: { 'Authorization': apiKey } });
        console.log("SUCCESS!");
        console.log("Status:", response.status);
        return;
    } catch (e) {
        console.log("Failed:", e.response ? e.response.status : e.message);
    }

    // Attempt 2: H-Dev-Key Header
    console.log("\n--- Attempt 2: H-Dev-Key Header ---");
    try {
        const response = await axios.get(url, { headers: { 'H-Dev-Key': apiKey } });
        console.log("SUCCESS!");
        console.log("Status:", response.status);
        return;
    } catch (e) {
        console.log("Failed:", e.response ? e.response.status : e.message);
    }

    // Attempt 3: Query Param (?)
    console.log("\n--- Attempt 3: Query Param (api_key) ---");
    try {
        const response = await axios.get(`${url}?api_key=${apiKey}`);
        console.log("SUCCESS!");
        console.log("Status:", response.status);
        return;
    } catch (e) {
        console.log("Failed:", e.response ? e.response.status : e.message);
    }

    // Attempt 4: No Key (Free Tier)
    console.log("\n--- Attempt 4: No Key ---");
    try {
        const response = await axios.get(url);
        console.log("SUCCESS!");
        console.log("Status:", response.status);
        return;
    } catch (e) {
        console.log("Failed:", e.response ? e.response.status : e.message);
        if (e.response && e.response.data) console.log("Data:", JSON.stringify(e.response.data));
    }
}

testApi();

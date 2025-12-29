const fs = require('fs');
const axios = require('axios');
const { EmbedBuilder } = require('discord.js');
const path = './leaderboard.json';
const usersPath = './users.json';

// Config
const POINTS = {
    WIN: 5,
    KILL: 1,
    ASSIST: 0.5,
    ACE: 10
};

// State
let leaderboardData = {
    channels: {}, // { guildId: channelId }
    lastUpdated: null,
    dailyScores: {} // { riotId: { points: 0, wins: 0, kills: 0, discordId: "123" } }
};

// Load Data
function loadData() {
    if (fs.existsSync(path)) {
        leaderboardData = JSON.parse(fs.readFileSync(path));
        // Migration check: if old format (single channelId) exists
        if (leaderboardData.channelId) {
            console.log("⚠️ Migrating old config to Multi-Server format...");
            leaderboardData.channels = { 'default': leaderboardData.channelId }; // Temporary migration
            delete leaderboardData.channelId;
            saveData();
        }
    }
}

// Save Data
function saveData() {
    fs.writeFileSync(path, JSON.stringify(leaderboardData, null, 2));
}

// Set Channel command handler (Per Guild)
function setChannel(guildId, channelId) {
    loadData();
    if (!leaderboardData.channels) leaderboardData.channels = {};
    leaderboardData.channels[guildId] = channelId;
    saveData();
    return true;
}

// Helper: Fetch matches for today
async function fetchDailyMatches(username, tag, region = 'ap') {
    try {
        const url = `https://api.henrikdev.xyz/valorant/v3/matches/${region}/${username}/${tag}?size=5&api_key=${process.env.VALORANT_API_KEY}`;
        const res = await axios.get(url);
        return res.data.data || [];
    } catch (e) {
        console.error(`Error fetching matches for ${username}#${tag}:`, e.message);
        return [];
    }
}

// Core: Update scores for all users
async function updateScores() {
    console.log('🔄 Updating Leaderboard Scores...');
    loadData();

    if (!fs.existsSync(usersPath)) return;
    const users = JSON.parse(fs.readFileSync(usersPath));
    const today = new Date().toDateString();

    // Reset if new day
    if (leaderboardData.lastUpdated !== today) {
        leaderboardData.dailyScores = {};
        leaderboardData.lastUpdated = today;
    }

    // Iterate all linked users
    for (const userId in users) {
        const user = users[userId];
        if (!user.riotId) continue;

        const [name, tag] = user.riotId.split('#');
        if (!name || !tag) continue;

        const matches = await fetchDailyMatches(name, tag);

        let points = 0;
        let wins = 0;
        let kills = 0;

        matches.forEach(m => {
            if (!m.metadata || !m.metadata.game_start_patched) return;

            const matchDate = new Date(m.metadata.game_start_patched).toDateString();
            if (matchDate !== today) return;

            const p = m.players.all_players.find(pl => pl.name.toLowerCase() === name.toLowerCase() && pl.tag.toLowerCase() === tag.toLowerCase());
            if (!p) return;

            kills += p.stats.kills;
            points += (p.stats.kills * POINTS.KILL);
            points += (p.stats.assists * POINTS.ASSIST);

            const team = p.team.toLowerCase();
            if (m.teams && m.teams[team] && m.teams[team].has_won) {
                points += POINTS.WIN;
                wins++;
            }
        });

        leaderboardData.dailyScores[user.riotId] = {
            points: Math.round(points),
            wins: wins,
            kills: kills,
            discordId: userId
        };

        // Rate limit safety
        await new Promise(r => setTimeout(r, 1000));
    }

    // Ensure all users are in the list
    for (const userId in users) {
        const user = users[userId];
        if (user.riotId && !leaderboardData.dailyScores[user.riotId]) {
            leaderboardData.dailyScores[user.riotId] = { points: 0, wins: 0, kills: 0, discordId: userId };
        }
    }

    saveData();
    console.log('✅ Leaderboard Updated.');
}

// Core: Post Embed (Multi-Server Logic)
async function postLeaderboard(client) {
    loadData();
    if (!leaderboardData.channels || Object.keys(leaderboardData.channels).length === 0) {
        return console.log('⚠️ No Leaderboard Configured for any server.');
    }

    const allScores = Object.entries(leaderboardData.dailyScores)
        .sort(([, a], [, b]) => b.points - a.points);

    // Iterate through EACH Guild configuration
    for (const [guildId, channelId] of Object.entries(leaderboardData.channels)) {
        try {
            const channel = await client.channels.fetch(channelId).catch(() => null);
            if (!channel) {
                console.log(`⚠️ Channel ${channelId} not found for Guild ${guildId}.`);
                console.log(`   -> Fix: Check if Bot has 'View Channel' permissions or if the ID was copied correctly.`);
                continue;
            }

            const guild = channel.guild;

            // Filter users: Only show score if the Discord User is in THIS Guild
            // We need to fetch/check membership.
            // Note: `guild.members.fetch(id)` might be heavy if done one by one for large lists.
            // Optimally, fetch all guild members once or rely on cache.
            // For simplicity/robustness: check existence.

            const guildScores = [];
            for (const [riotId, stats] of allScores) {
                try {
                    // Check if member exists in guild
                    const member = await guild.members.fetch(stats.discordId).catch(() => null);
                    if (member) {
                        guildScores.push({ riotId, stats, member });
                    }
                } catch (e) {
                    // ignore
                }
            }

            if (guildScores.length === 0) {
                // Option: Post "No players active" or just skip
                // skipping to reduce spam
                continue;
            }

            const embed = new EmbedBuilder()
                .setColor(0xFFD700)
                .setTitle(`📅 Daily Valorant Leaderboard (${new Date().toLocaleDateString()})`)
                .setDescription('Top performers of the day! 🏆\n*Scores reset daily at 23:59.*')
                .setThumbnail('https://img.icons8.com/3d-fluency/94/trophy.png')
                .setFooter({ text: `Tracking ${guildScores.length} players in ${guild.name} • Updates Hourly` });

            // Top 15 for this guild
            const topList = guildScores.slice(0, 15);

            let rank = 1;
            for (const item of topList) {
                const { riotId, stats, member } = item;
                const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `#${rank}`;
                const displayName = member.user.username; // Use Discord Username

                const highlight = rank <= 3 ? '**' : '';

                embed.addFields({
                    name: `${medal} ${displayName}`,
                    value: `🆔 \`${riotId}\`\n${highlight}${stats.points} Pts${highlight} (${stats.wins} W • ${stats.kills} K)`,
                    inline: false
                });
                rank++;
            }

            await channel.send({ embeds: [embed] });
            console.log(`✅ Posted Leaderboard for Guild: ${guild.name}`);

        } catch (err) {
            console.error(`❌ Error posting to Guild ${guildId}:`, err);
        }
    }
}

// Scheduler
function startScheduler(client) {
    setInterval(() => {
        const now = new Date();
        const minutes = now.getMinutes();

        if (minutes === 0) {
            updateScores();
        }

        if (now.getHours() === 23 && minutes === 59) {
            console.log("🕛 Midnight Logic: Posting Leaderboard...");
            postLeaderboard(client);
        }
    }, 1000 * 60);
}

module.exports = { setChannel, updateScores, postLeaderboard, startScheduler };

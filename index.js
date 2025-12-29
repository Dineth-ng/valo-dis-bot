require('dotenv').config();
const { Client, GatewayIntentBits, Events, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const path = './users.json';
const { analyzeMatch, createTimelineEmbed } = require('./matchAnalytics');
const { getTopStats } = require('./profileAnalytics');
const { setChannel, startScheduler, postLeaderboard, updateScores } = require('./leaderboardManager');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMembers // Required for Leaderboard filtering
    ]
});

client.once(Events.ClientReady, c => {
    console.log(`Ready! Logged in as ${c.user.tag}`);
    startScheduler(client); // Start Leaderboard Scheduler
});

// Helper to resolve Riot ID from Nickname or Discord ID
function resolveUser(message, splitArgs, nicknameIndex) {
    let users = {};
    if (fs.existsSync(path)) {
        users = JSON.parse(fs.readFileSync(path));
    }

    // Case 1: Mention, Raw ID, or Nickname provided
    if (splitArgs.length > nicknameIndex) {
        const input = splitArgs[nicknameIndex];

        // Check for Mention
        const mentionMatch = input.match(/^<@!?(\d+)>$/);
        if (mentionMatch) {
            const mentionedId = mentionMatch[1];
            if (users[mentionedId]) {
                return { riotId: users[mentionedId].riotId, method: 'mention' };
            }
            return { riotId: null, method: 'mention', error: `❌ The user <@${mentionedId}> is not linked to the bot.` };
        }

        // Check for Raw ID (17-19 digit number)
        if (input.match(/^\d{17,19}$/)) {
            if (users[input]) {
                return { riotId: users[input].riotId, method: 'id' };
            }
            return { riotId: null, method: 'id', error: `❌ The Discord ID **${input}** is not linked.` };
        }

        // Check for Nickname
        for (const id in users) {
            if (users[id].nickname === input) {
                return { riotId: users[id].riotId, method: 'nickname' };
            }
        }
        return { riotId: null, method: 'nickname', error: `❌ No user found with nickname **${input}**.` };
    }

    // Case 2: Auto-detect via Discord ID
    if (users[message.author.id]) {
        return { riotId: users[message.author.id].riotId, method: 'auto' };
    }

    return { riotId: null, method: 'auto', error: `❌ You are not linked! Use \`/valo -link [RiotID]\` first.` };
}

client.on(Events.MessageCreate, async message => {
    if (message.author.bot) return;

    // Command: /valo -link [RiotID]
    if (message.content.startsWith('/valo -link')) {
        const args = message.content.split(' ');
        if (args.length < 3) {
            return message.reply('Usage: `/valo -link Name#Tag`');
        }

        const riotId = args.slice(2).join(' ');

        const embed = new EmbedBuilder()
            .setColor(0xFF4654)
            .setTitle('Valorant Linking Configuration')
            .setDescription(`**Secure Setup** 🔒\n\nDo you wish to link your Discord account with the Riot ID **${riotId}**?\n\n*This conversation is private.*`)
            .setImage('https://pbs.twimg.com/media/E9-u_XVVIAQyqC_.jpg')
            .setFooter({ text: 'Valorant Bot • Leagues.gg' });

        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`link_yes_${message.author.id}_${riotId}`)
                    .setLabel('Yes, Link Account')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(`link_no_${message.author.id}`)
                    .setLabel('Cancel')
                    .setStyle(ButtonStyle.Danger),
            );

        try {
            await message.author.send({ embeds: [embed], components: [row] });
            // Notify in server
            await message.reply({ content: '📩 **Check your DMs!** I\'ve sent you a secure verification message.', ephemeral: true });
        } catch (error) {
            console.error(error);
            await message.reply('❌ I couldn\'t DM you. Please check your privacy settings and allow Direct Messages from this server.');
        }
    }

    // Command: /valo -setleaderboard [channel]
    if (message.content.startsWith('/valo -setleaderboard')) {
        // Permission check: Admin only (dummy check for simplicity, ideally check Permissions.FLAGS.ADMINISTRATOR)
        // For now allowing anyone as it's a test bot, or check ID

        const channelId = message.channel.id;
        const guildId = message.guild.id;
        const success = setChannel(guildId, channelId);

        if (success) {
            message.reply(`✅ **Leaderboard Channel Configured!**\nDaily updates will be posted in <#${channelId}> for this server.`);
            // Trigger an initial update for testing
            updateScores().then(() => postLeaderboard(client));
        }
    }

    // Command: /valo -nickname [RiotID] [Nickname]
    if (message.content.startsWith('/valo -nickname')) {
        const args = message.content.split(' ');
        if (args.length < 4) {
            return message.reply('Usage: `/valo -nickname RiotID [nickname]` (e.g. `brim#1234 spicydn`)');
        }

        const riotId = args[2];
        const nickname = args[3];

        let users = {};
        if (fs.existsSync(path)) {
            users = JSON.parse(fs.readFileSync(path));
        }

        let found = false;
        for (const userId in users) {
            if (users[userId].riotId === riotId || users[userId].riotId.replace(/\s/g, '') === riotId) {
                users[userId].nickname = nickname;
                found = true;
                break;
            }
        }

        if (!found) {
            return message.reply(`❌ Riot ID **${riotId}** not found. Please link it first using \`/valo -link\`.`);
        }

        fs.writeFileSync(path, JSON.stringify(users, null, 2));
        message.reply(`✅ Nickname **${nickname}** set for **${riotId}**!`);
    }

    // Command: /lmatch [nickname]
    if (message.content.startsWith('/lmatch')) {
        const args = message.content.split(' ');

        const result = resolveUser(message, args, 1);
        if (!result.riotId) {
            return message.reply(result.error);
        }
        const targetRiotId = result.riotId;

        const matches = targetRiotId.match(/(.+?)#(.+)/);
        if (!matches) {
            return message.reply(`❌ Invalid Riot ID format stored: ${targetRiotId}`);
        }
        const name = matches[1];
        const tag = matches[2];
        const region = 'ap';

        try {
            const response = await axios.get(`https://api.henrikdev.xyz/valorant/v3/matches/${region}/${name}/${tag}?api_key=${process.env.VALORANT_API_KEY}`);

            if (!response.data || !response.data.data || response.data.data.length === 0) {
                return message.reply(`❌ No recent matches found for **${targetRiotId}**.`);
            }

            const lastMatch = response.data.data[0];
            const meta = lastMatch.metadata;
            const playerStats = lastMatch.players.all_players.find(p => p.name.toLowerCase() === name.toLowerCase() && p.tag.toLowerCase() === tag.toLowerCase());

            if (!playerStats) {
                return message.reply(`❌ Could not find player stats in the last match.`);
            }

            const team = playerStats.team.toLowerCase();
            const won = lastMatch.teams[team].has_won;
            const resultColor = won ? 0x00FF00 : 0xFF0000;
            const resultText = won ? 'Victory' : 'Defeat';

            const kda = `${playerStats.stats.kills}/${playerStats.stats.deaths}/${playerStats.stats.assists}`;
            const agent = playerStats.character;

            const myScore = lastMatch.teams[team].rounds_won;
            const enemyTeam = team === 'red' ? 'blue' : 'red';
            const enemyScore = lastMatch.teams[enemyTeam].rounds_won;
            const scoreDisplay = `${myScore} - ${enemyScore}`;

            const totalShots = playerStats.stats.headshots + playerStats.stats.bodyshots + playerStats.stats.legshots;
            const hsPercentage = totalShots > 0 ? Math.round((playerStats.stats.headshots / totalShots) * 100) : 0;

            const embed = new EmbedBuilder()
                .setColor(resultColor)
                .setTitle(`Match History for ${targetRiotId}`)
                .setDescription(`**Map**: ${meta.map}\n**Mode**: ${meta.mode}`)
                .addFields(
                    { name: 'Result', value: resultText, inline: true },
                    { name: 'Score', value: scoreDisplay, inline: true },
                    { name: 'Agent', value: agent, inline: true },
                    { name: 'KDA', value: kda, inline: true },
                    { name: 'HS%', value: `${hsPercentage}%`, inline: true }
                )
                .setThumbnail(playerStats.assets.agent.small)
                .setTimestamp(new Date(meta.game_start_patched));

            message.reply({ embeds: [embed] });

        } catch (error) {
            console.error('API Error:', error.response ? error.response.data : error.message);
            if (error.response && error.response.status === 404) {
                return message.reply(`❌ Player **${targetRiotId}** not found or matches private.`);
            } else if (error.response && error.response.status === 401) {
                return message.reply(`❌ **API Error**: Invalid API Key. Please update \`.env\` with a valid HenrikDev API key.`);
            }
            message.reply('❌ Error fetching match data. Please try again later.');
        }
    }

    // Command: /valo -rank [nickname]
    if (message.content.startsWith('/valo -rank')) {
        const args = message.content.split(' ');

        const result = resolveUser(message, args, 2);
        if (!result.riotId) {
            return message.reply(result.error);
        }
        const targetRiotId = result.riotId;

        const matches = targetRiotId.match(/(.+?)#(.+)/);
        if (!matches) return message.reply("Invalid Riot ID format.");
        const name = matches[1];
        const tag = matches[2];
        const region = 'ap';

        try {
            const url = `https://api.henrikdev.xyz/valorant/v1/mmr/${region}/${name}/${tag}?api_key=${process.env.VALORANT_API_KEY}`;
            const response = await axios.get(url);

            if (!response.data || !response.data.data) {
                return message.reply(`❌ Could not fetch rank for **${targetRiotId}**. (Maybe unranked?)`);
            }

            const data = response.data.data;

            const embed = new EmbedBuilder()
                .setColor(0xFF4654)
                .setTitle(`Competitive Rank: ${targetRiotId}`)
                .setThumbnail(data.images.large)
                .addFields(
                    { name: 'Rank', value: data.currenttierpatched, inline: true },
                    { name: 'RR', value: `${data.ranking_in_tier}/100`, inline: true },
                    { name: 'Elo', value: `${data.elo}`, inline: true }
                )
                .setFooter({ text: 'Season: ' + (data.season_id || 'Current') });

            message.reply({ embeds: [embed] });

        } catch (error) {
            console.error('Rank API Error:', error.response ? error.response.status : error.message);
            if (error.response && error.response.status === 404) {
                return message.reply(`❌ Player **${targetRiotId}** has no competitive history or is private.`);
            }
            message.reply('❌ Error fetching rank.');
        }
    }

    // Command: /valo -agent [nickname (optional)]
    if (message.content.startsWith('/valo -agent')) {
        const args = message.content.split(' ');

        const result = resolveUser(message, args, 2);
        if (!result.riotId) {
            return message.reply(result.error);
        }
        const targetRiotId = result.riotId;

        const matches = targetRiotId.match(/(.+?)#(.+)/);
        if (!matches) return message.reply("Invalid Riot ID format.");
        const name = matches[1];
        const tag = matches[2];
        const region = 'ap';

        try {
            await message.reply(`🔄 Fetching agent stats for **${targetRiotId}** (This might take a second)...`);

            const url = `https://api.henrikdev.xyz/valorant/v3/matches/${region}/${name}/${tag}?size=20&api_key=${process.env.VALORANT_API_KEY}`;
            const response = await axios.get(url);

            if (!response.data || !response.data.data || response.data.data.length === 0) {
                return message.channel.send(`❌ No recent matches found for **${targetRiotId}**.`);
            }

            const matchData = response.data.data;
            const agentStats = {};

            matchData.forEach(match => {
                if (!match.players || !match.players.all_players) return;

                const player = match.players.all_players.find(p => p.name.toLowerCase() === name.toLowerCase() && p.tag.toLowerCase() === tag.toLowerCase());
                if (player) {
                    const agentName = player.character;
                    if (!agentStats[agentName]) {
                        agentStats[agentName] = { name: agentName, played: 0, kills: 0, deaths: 0, assists: 0, wins: 0, icon: player.assets.agent.small };
                    }
                    agentStats[agentName].played++;
                    agentStats[agentName].kills += player.stats.kills;
                    agentStats[agentName].deaths += player.stats.deaths;
                    agentStats[agentName].assists += player.stats.assists;
                    if (match.teams && match.teams[player.team.toLowerCase()] && match.teams[player.team.toLowerCase()].has_won) {
                        agentStats[agentName].wins++;
                    }
                }
            });

            const sortedAgents = Object.values(agentStats).sort((a, b) => b.played - a.played).slice(0, 5);

            const embed = new EmbedBuilder()
                .setColor(0xFF4654)
                .setTitle(`Top 5 Agents (Last ${matchData.length} Matches)`)
                .setDescription(`Agent performance for **${targetRiotId}**`)
                .setThumbnail(sortedAgents[0] ? sortedAgents[0].icon : null);

            sortedAgents.forEach((agent, index) => {
                const winRate = Math.round((agent.wins / agent.played) * 100);
                const kd = (agent.kills / (agent.deaths || 1)).toFixed(2);
                embed.addFields({
                    name: `#${index + 1} ${agent.name}`,
                    value: `Matches: **${agent.played}** | WR: **${winRate}%** | K/D: **${kd}**`,
                    inline: false
                });
            });

            message.channel.send({ embeds: [embed] });

        } catch (error) {
            console.error('Agent API Error:', error.response ? error.response.status : error.message);
            if (error.response && error.response.status === 502) {
                return message.reply("❌ **API Error (502)**: The Valorant API is currently down or overloaded. Please try again later.");
            }
            message.channel.send('❌ Error fetching agent stats.');
        }
    }

    // Command: /valo -timeline [nickname (optional)]
    if (message.content.startsWith('/valo -timeline')) {
        const args = message.content.split(' ');

        const result = resolveUser(message, args, 2);
        if (!result.riotId) {
            return message.reply(result.error);
        }
        const targetRiotId = result.riotId;

        const matches = targetRiotId.match(/(.+?)#(.+)/);
        if (!matches) return message.reply("Invalid Riot ID format.");
        const name = matches[1];
        const tag = matches[2];
        const region = 'ap';

        try {
            await message.channel.send(`🔄 Fetching match timeline for **${targetRiotId}**...`);

            // 1. Get Match ID
            const historyUrl = `https://api.henrikdev.xyz/valorant/v3/matches/${region}/${name}/${tag}?size=1&api_key=${process.env.VALORANT_API_KEY}`;
            const historyRes = await axios.get(historyUrl);

            if (!historyRes.data.data || historyRes.data.data.length === 0) {
                return message.reply("❌ No matches found.");
            }
            const matchId = historyRes.data.data[0].metadata.matchid;

            // 2. Fetch Full Match Details
            const matchUrl = `https://api.henrikdev.xyz/valorant/v2/match/${matchId}?api_key=${process.env.VALORANT_API_KEY}`;
            const matchRes = await axios.get(matchUrl);
            const matchData = matchRes.data.data;

            // 3. Analyze
            const timeline = analyzeMatch(matchData, targetRiotId);

            // 4. Send Embed
            const embed = createTimelineEmbed(matchData, timeline, 1);

            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`timeline_prev_1_${matchId}`)
                        .setLabel('Previous')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(true),
                    new ButtonBuilder()
                        .setCustomId(`timeline_next_1_${matchId}`)
                        .setLabel('Next')
                        .setStyle(ButtonStyle.Primary)
                );

            await message.reply({ embeds: [embed], components: [row] });

        } catch (error) {
            console.error('Timeline API Error:', error.response ? error.response.status : error.message);
            if (error.response && error.response.status === 502) {
                return message.reply("❌ **API Error (502)**: The Valorant API is currently down or overloaded. Please try again in 5 minutes.");
            }
            message.reply("❌ Error fetching timeline.");
        }
    }

    // Command: /valo -profile [nickname (optional)]
    if (message.content.startsWith('/valo -profile')) {
        const args = message.content.split(' ');

        const result = resolveUser(message, args, 2);
        if (!result.riotId) {
            return message.reply(result.error);
        }
        const targetRiotId = result.riotId;

        const matches = targetRiotId.match(/(.+?)#(.+)/);
        if (!matches) return message.reply("Invalid Riot ID format.");
        const name = matches[1];
        const tag = matches[2];
        const region = 'ap';

        try {
            await message.channel.send(`🔄 Fetching profile for **${targetRiotId}**...`);

            // Parallel Data Fetching
            const accountUrl = `https://api.henrikdev.xyz/valorant/v1/account/${name}/${tag}?api_key=${process.env.VALORANT_API_KEY}`;
            const mmrUrl = `https://api.henrikdev.xyz/valorant/v1/mmr/${region}/${name}/${tag}?api_key=${process.env.VALORANT_API_KEY}`;
            const matchesUrl = `https://api.henrikdev.xyz/valorant/v3/matches/${region}/${name}/${tag}?size=20&api_key=${process.env.VALORANT_API_KEY}`;

            const [accountRes, mmrRes, matchesRes] = await Promise.all([
                axios.get(accountUrl).catch(e => ({ data: { data: null } })),
                axios.get(mmrUrl).catch(e => ({ data: { data: null } })),
                axios.get(matchesUrl).catch(e => ({ data: { data: [] } }))
            ]);

            const account = accountRes.data.data;
            const mmr = mmrRes.data.data;
            const matchHistory = matchesRes.data.data;

            if (!account) return message.reply("❌ Could not find account data. (Rank/Matches might be private)");

            // Analytics
            const stats = getTopStats(matchHistory, account.puuid, name, tag);

            const embed = new EmbedBuilder()
                .setColor(0xFF4654)
                .setTitle(`${account.name}#${account.tag}`)
                .setThumbnail(mmr ? mmr.images.large : account.card.small)
                .setImage(account.card.wide)
                .setDescription(`**Region**: ${account.region.toUpperCase()} | **Level**: ${account.account_level}`)
                .addFields(
                    { name: '🏆 Current Rank', value: (mmr && mmr.currenttierpatched) ? `${mmr.currenttierpatched} (${mmr.ranking_in_tier} RR)` : 'Unranked', inline: true },
                    { name: '🏔️ Peak Rank', value: (mmr && mmr.highest_rank) ? mmr.highest_rank.patched_tier : 'N/A', inline: true },
                    { name: '\u200B', value: '\u200B', inline: true }, // Spacer
                    { name: '🔫 Top Weapon', value: stats ? stats.topWeapon : 'N/A', inline: true },
                    { name: '🗺️ Top Map', value: stats ? stats.topMap : 'N/A', inline: true },
                    { name: '🦸 Top Agent', value: stats ? stats.topAgent : 'N/A', inline: true },
                    { name: '👯 Top Duo', value: stats ? stats.topFriend : 'None', inline: true }
                )
                .setFooter({ text: `Last Updated: ${account.last_update ? new Date(account.last_update).toLocaleDateString() : 'Unknown'}` });

            message.reply({ embeds: [embed] });

        } catch (error) {
            console.error('Profile API Error:', error);
            if (error.response && error.response.status === 502) {
                return message.reply("❌ **API Error (502)**: Valorant API is down.");
            }
            message.reply("❌ Error fetching profile.");
        }
    }

    // Command: /valo -compare [target]
    if (message.content.startsWith('/valo -compare')) {
        const args = message.content.split(' ');

        // 1. Resolve User A (Author)
        const userA = resolveUser(message, [], 0); // Self lookup
        if (!userA.riotId) return message.reply("❌ You are not linked! Type `/valo -profile` to verify yourself first.");

        // 2. Resolve User B (Target)
        const userB = resolveUser(message, args, 2); // Argument lookup
        if (!userB.riotId) return message.reply("❌ Please specify a user to compare with: `/valo -compare [Name#Tag / Nickname / Mention / Discord_ID]`");

        const targetA = userA.riotId;
        const targetB = userB.riotId;

        try {
            const loadingMsg = await message.channel.send(`⚔️ **1v1 Battle:** ${targetA} 🆚 ${targetB}...\n*Judge AI is analyzing the tapes...* 🤖`);

            // Helper to fetch data for one user
            const fetchUserData = async (riotId) => {
                const parts = riotId.match(/(.+?)#(.+)/);
                if (!parts) return null;
                const name = parts[1];
                const tag = parts[2];
                const region = 'ap';

                const matchesUrl = `https://api.henrikdev.xyz/valorant/v3/matches/${region}/${name}/${tag}?size=20&api_key=${process.env.VALORANT_API_KEY}`;
                const mmrUrl = `https://api.henrikdev.xyz/valorant/v1/mmr/${region}/${name}/${tag}?api_key=${process.env.VALORANT_API_KEY}`;

                const [matchesRes, mmrRes] = await Promise.all([
                    axios.get(matchesUrl).catch(e => ({ data: { data: [] } })),
                    axios.get(mmrUrl).catch(e => ({ data: { data: null } }))
                ]);

                const matches = matchesRes.data.data;
                const mmr = mmrRes.data.data;

                let puuid = null;
                // Calculate Win Rate
                let wins = 0;
                let matchesPlayed = 0;

                if (matches && matches.length > 0) {
                    const p = matches[0].players.all_players.find(pl => pl.name.toLowerCase() === name.toLowerCase() && pl.tag.toLowerCase() === tag.toLowerCase());
                    if (p) puuid = p.puuid;

                    matches.forEach(m => {
                        if (!m.metadata || !m.teams) return;
                        // This simple check assumes name match is enough or use helper
                        const player = m.players.all_players.find(pl => pl.name.toLowerCase() === name.toLowerCase() && pl.tag.toLowerCase() === tag.toLowerCase());
                        if (player) {
                            matchesPlayed++;
                            if (m.teams[player.team.toLowerCase()].has_won) wins++;
                        }
                    });
                }

                const winRate = matchesPlayed > 0 ? ((wins / matchesPlayed) * 100).toFixed(1) : "0.0";
                const stats = getTopStats(matches, puuid, name, tag);
                return { name, tag, mmr, stats, winRate };
            };

            const [dataA, dataB] = await Promise.all([
                fetchUserData(targetA),
                fetchUserData(targetB)
            ]);

            if (!dataA || !dataB) return message.reply("❌ Failed to fetch data for one of the players.");

            // Prepare Data for AI
            // Simplified Rank handling
            const rankA = dataA.mmr && dataA.mmr.currenttierpatched ? dataA.mmr.currenttierpatched : "Unranked";
            const eloA = dataA.mmr ? dataA.mmr.elo : 0;

            const rankB = dataB.mmr && dataB.mmr.currenttierpatched ? dataB.mmr.currenttierpatched : "Unranked";
            const eloB = dataB.mmr ? dataB.mmr.elo : 0;

            const prompt = `
            You are a Savage Valorant Analyst.
            
            **Player A (${dataA.name}):**
            - Rank: ${rankA} (Elo: ${eloA})
            - KD: ${dataA.stats.kda}
            - HS%: ${dataA.stats.hs}
            - Win Rate: ${dataA.winRate}%
            - Main: ${dataA.stats.topAgent}

            **Player B (${dataB.name}):**
            - Rank: ${rankB} (Elo: ${eloB})
            - KD: ${dataB.stats.kda}
            - HS%: ${dataB.stats.hs}
            - Win Rate: ${dataB.winRate}%
            - Main: ${dataB.stats.topAgent}

            **Instructions:**
            1. Analyze their meaningful stats (Gameplay, Impact, Consistency).
            2. Assign a **Performance Score** (0-100) for each.
            3. Declare the WINNER.
            4. Generate the response STRICTLY in this format:

            WINNER: [Name]
            SCORE_A: [Score for A]/100
            SCORE_B: [Score for B]/100
            SPEECH: [Funny, motivational victory speech for the winner. Mention specific stats. 3-4 sentences (Longer).]
            ROAST: [Funny, savage roast for the loser. Mock their rank/aim. 3-4 sentences (Longer).]
            `;

            // Call Groq
            const aiResponse = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
                model: "llama-3.3-70b-versatile",
                messages: [
                    { role: "system", content: "You are a funny, savage Valorant commentator." },
                    { role: "user", content: prompt }
                ],
                max_tokens: 500
            }, {
                headers: {
                    'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
                    'Content-Type': 'application/json'
                }
            });

            const text = aiResponse.data.choices[0].message.content;

            // Parse
            // Parse
            let winner = "Unknown";
            let scoreA = "0/100";
            let scoreB = "0/100";
            let speech = "GG!";
            let roast = "Nt.";

            text.split('\n').forEach(line => {
                if (line.includes('WINNER:')) winner = line.replace('WINNER:', '').trim();
                if (line.includes('SCORE_A:')) scoreA = line.replace('SCORE_A:', '').trim();
                if (line.includes('SCORE_B:')) scoreB = line.replace('SCORE_B:', '').trim();
                if (line.includes('SPEECH:')) speech = line.replace('SPEECH:', '').trim();
                if (line.includes('ROAST:')) roast = line.replace('ROAST:', '').trim();
            });

            // Fallback content in description if parsing weird
            if (speech === "GG!") speech = text;

            const embed = new EmbedBuilder()
                .setColor(0xF8BF60) // Gold
                .setTitle(`⚔️ 1v1 SHOWDOWN ⚔️`)
                .setDescription(`**${dataA.name}** vs **${dataB.name}**\n\n**Winner**: ${winner} 👑`)
                .addFields(
                    { name: `� Match Rating`, value: `**${dataA.name}**: ${scoreA}\n**${dataB.name}**: ${scoreB}`, inline: false },
                    { name: `🎤 Winner's Spotlight`, value: `"${speech}"`, inline: false },
                    { name: `💀 Loser Roast`, value: `"${roast}"`, inline: false },
                    {
                        name: '📊 Stat Comparison', value: `
**Rank**: ${rankA} vs ${rankB}
**K/D**: ${dataA.stats.kda} vs ${dataB.stats.kda}
**Win Rate**: ${dataA.winRate}% vs ${dataB.winRate}%
**HS%**: ${dataA.stats.hs} vs ${dataB.stats.hs}
                    `, inline: false
                    }
                )
                .setThumbnail('https://media.giphy.com/media/l4pT2ASyWWGw4pDms/giphy.gif')
                .setFooter({ text: 'Verdict by AI Judge • No Refunds' });

            await loadingMsg.edit({ content: '', embeds: [embed] });

        } catch (error) {
            console.error(error);
            message.reply("❌ Error analyzing the battle. AI Judge is asleep.");
        }
    }
    // Command: /valo -help / -h
    if (message.content.startsWith('/valo -help') || message.content.startsWith('/valo -h')) {
        const embed = new EmbedBuilder()
            .setColor(0xFF4654)
            .setTitle('Valorant Bot Commands 🤖')
            .setDescription('Your ultimate companion for stats, strats, and roasts!')
            .addFields(
                {
                    name: '⚙️ **Setup**',
                    value: '`/valo -link Name#Tag` - Securely link your Riot Account\n`/valo -nickname RiotID [Alias]` - Set a custom nickname'
                },
                {
                    name: '🏆 **Leaderboard System**',
                    value: 'Earn points automatically by playing Competitive!\n**Win**: +5 Pts | **Kill**: +1 Pt | **Assist**: +0.5 Pt\n*Resets daily at 00:00 UTC.*'
                },
                {
                    name: '📊 **Stats & Analysis**',
                    value: '`/lmatch` - Last Match Summary\n`/valo -profile` - Full Account Overview\n`/valo -rank` - Check your Elo/RR\n`/valo -timeline` - Round-by-Round Breakdown'
                },
                {
                    name: '🧠 **AI Strategy & Fun**',
                    value: '`/valo -teamup [Map] [Users]` - AI Team Builder & Strat Generator\n`/valo -advice` - Personalized Coaching Tips\n`/valo -compare [User]` - 1v1 Stat Battle (with AI Judge)'
                },
                {
                    name: '🚀 **Coming Soon (Roadmap)**',
                    value: '🔹 **Daily Challenges**: Complete specific tasks for bonus points!\n🔹 **Agent Roulette**: Fun strats for 5-stacks.\n🔹 **Scrim Mode**: Custom lobby tools.'
                }
            )
            .setFooter({ text: 'Powered by Spicy • "Admin settings are hidden 🤫"' });

        message.reply({ embeds: [embed] });
    }

    // Command: /valo -advice [User (Optional)]
    if (message.content.startsWith('/valo -advice')) {
        const args = message.content.split(' ');

        // 1. Resolve User
        const result = resolveUser(message, args, 2);
        if (!result.riotId) {
            return message.reply(result.error);
        }
        const targetRiotId = result.riotId;

        const pMatches = targetRiotId.match(/(.+?)#(.+)/);
        if (!pMatches) return message.reply("Invalid Riot ID format.");
        const name = pMatches[1];
        const tag = pMatches[2];
        const region = 'ap';

        // Check for API Key
        if (!process.env.GROQ_API_KEY) {
            return message.reply("❌ **Configuration Error**: `GROQ_API_KEY` is missing in the bot settings.");
        }

        try {
            const loadingMsg = await message.reply(`🧠 **AI Coach is analyzing ${targetRiotId}'s gameplay...**\n*Reading match history, calculating stats, and formulating advice...*`);

            // 2. Fetch Data (Profile + Matches)
            const matchesUrl = `https://api.henrikdev.xyz/valorant/v3/matches/${region}/${name}/${tag}?size=10&api_key=${process.env.VALORANT_API_KEY}`;
            const mmrUrl = `https://api.henrikdev.xyz/valorant/v1/mmr/${region}/${name}/${tag}?api_key=${process.env.VALORANT_API_KEY}`;

            const [matchesRes, mmrRes] = await Promise.all([
                axios.get(matchesUrl).catch(e => ({ data: { data: [] } })),
                axios.get(mmrUrl).catch(e => ({ data: { data: null } }))
            ]);

            const matches = matchesRes.data.data;
            const mmr = mmrRes.data.data;

            if (!matches || matches.length === 0) {
                return loadingMsg.edit("❌ No recent matches found to analyze.");
            }

            // 3. Prepare Context for AI
            const stats = getTopStats(matches, null, name, tag); // Use existing analytics
            const rank = (mmr && mmr.currenttierpatched) ? `${mmr.currenttierpatched} (${mmr.ranking_in_tier} RR)` : "Unranked";

            // Calculate W/L for last 10
            let wins = 0;
            let losses = 0;
            const recentResults = matches.map(m => {
                if (!m.players || !m.players.all_players) return 'Invalid Match Data';

                const p = m.players.all_players.find(pl => pl.name.toLowerCase() === name.toLowerCase() && pl.tag.toLowerCase() === tag.toLowerCase());
                if (!p) return 'Unknown';
                const won = m.teams[p.team.toLowerCase()].has_won;
                if (won) wins++; else losses++;
                return `${won ? 'WIN' : 'LOSS'} (${p.character}, KDA: ${p.stats.kills}/${p.stats.deaths}/${p.stats.assists})`;
            }).filter(r => r !== 'Invalid Match Data').join('\n');

            const prompt = `
            You are an expert Valorant Coach. Analyze this player's stats and give them constructive, personalized advice to improve.
            
            **Player Profile:**
            - **Rank**: ${rank}
            - **Main Agent**: ${stats.topAgent}
            - **Overall K/D (Last 10)**: ${stats.kda}
            - **Headshot %**: ${stats.hs}
            - **Win Record**: ${wins} Wins - ${losses} Losses
            
            **Recent Match History:**
            ${recentResults}
            
            **Instructions:**
            1. **Summarize** their recent performance in 1-2 bullet points.
            2. **Identify** their biggest strength based on the data.
            3. **Pinpoint** a key weakness or bad habit they might have (infer from agent choice vs stats, or win rate).
            4. **Give 1 concrete Tip** for their next game (e.g., specific agent utility usage, aim training, or positioning).
            
            Keep the tone encouraging but professional. Use emojis. Keep the response under 1500 characters.
            `;

            // 4. Call Groq API
            const aiResponse = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
                model: "llama-3.3-70b-versatile",
                messages: [
                    { role: "system", content: "You are a helpful and knowledgeable Valorant Esports Coach." },
                    { role: "user", content: prompt }
                ],
                max_tokens: 600
            }, {
                headers: {
                    'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
                    'Content-Type': 'application/json'
                }
            });

            const advice = aiResponse.data.choices[0].message.content;

            // 5. Build Embed
            const embed = new EmbedBuilder()
                .setColor(0xF55036) // Groq Orange
                .setTitle(`🤖 AI Coach Analysis: ${targetRiotId}`)
                .setDescription(advice)
                .setThumbnail(mmr ? mmr.images.small : null)
                .setFooter({ text: 'Powered by Spicy & Valo-Bot Analytics' });

            await loadingMsg.edit({ content: '', embeds: [embed] });

        } catch (error) {
            console.error("AI Advice Error:", error.response ? error.response.data : error.message);

            let userMsg = "❌ Error generating advice. The AI might be busy.";

            if (error.response) {
                if (error.response.status === 401) {
                    userMsg = "❌ **API Error**: Invalid Groq API Key.";
                } else if (error.response.status === 429) {
                    userMsg = "❌ **API Error**: Groq Rate Limit Exceeded. Try again later.";
                }
            } else if (error.message.includes('all_players')) {
                userMsg = "❌ **Data Error**: Encountered incomplete match data. Skiped analysis.";
            }

            try {
                await loadingMsg.edit(userMsg);
            } catch (e) {
                await message.reply(userMsg);
            }
        }
    }

    // Command: /valo -teamup [Map] [User1] [User2]...
    if (message.content.startsWith('/valo -teamup')) {
        const args = message.content.split(/\s+/);
        // Expected: /valo -teamup MapName User1 ...
        // args[0]="/valo", args[1]="-teamup", args[2]=MapName
        if (args.length < 3) {
            return message.reply("Usage: `/valo -teamup <MapName> [Player1] [Player2] ...`\nExample: `/valo -teamup Ascent @Jett @Sova`");
        }

        const mapName = args[2];
        const usersToAnalyze = [];

        // 1. Mentions
        message.mentions.users.forEach(u => usersToAnalyze.push({ type: 'discord', id: u.id, name: u.username }));

        // 2. Raw Args (from index 3 onwards)
        const rawArgs = args.slice(3);
        const addedIds = usersToAnalyze.map(u => u.id);

        for (const arg of rawArgs) {
            // 17-19 digit ID
            if (/^\d{17,19}$/.test(arg)) {
                if (!addedIds.includes(arg)) {
                    usersToAnalyze.push({ type: 'discord', id: arg, name: 'Unknown' });
                    addedIds.push(arg);
                }
            }
            // Riot ID
            else if (arg.includes('#') && !arg.startsWith('<@')) {
                if (!addedIds.includes(arg)) {
                    usersToAnalyze.push({ type: 'riot', id: arg, name: arg });
                    addedIds.push(arg);
                }
            }
        }

        // If no one specified, add sender
        // Logic change: ALWAYS include the sender unless they mentioned themselves.
        const senderId = message.author.id;
        const senderIncluded = usersToAnalyze.some(u => u.type === 'discord' && u.id === senderId);

        if (!senderIncluded) {
            usersToAnalyze.push({ type: 'discord', id: senderId, name: message.author.username });
        }

        if (usersToAnalyze.length > 5) {
            return message.reply("⚠️ Maximum 5 players allowed for a team composition.");
        }

        const loadingMsg = await message.reply(`🛡️ **Scouting Report: ${mapName}**\n*Analyzing ${usersToAnalyze.length} player(s) for the perfect team comp...*`);

        // Resolve Data
        const playerData = [];
        const errors = [];

        // Load users DB once per command to be efficient
        let localUsers = {};
        try {
            if (fs.existsSync(path)) localUsers = JSON.parse(fs.readFileSync(path));
        } catch (e) { }

        const fetchPlayerStats = async (userObj) => {
            let riotId = null;
            let displayName = userObj.name;

            if (userObj.type === 'discord') {
                const uData = Object.values(localUsers).find(u => u.discordId === userObj.id);
                if (uData) {
                    riotId = uData.riotId;
                    displayName = uData.nickname || uData.username;
                }
            } else {
                riotId = userObj.id;
            }

            if (!riotId) {
                errors.push(`Unlinked: ${displayName}`);
                return null;
            }

            const pMatches = riotId.match(/(.+?)#(.+)/);
            if (!pMatches) return null;

            const name = pMatches[1];
            const tag = pMatches[2];
            const region = 'ap';

            try {
                const matchesUrl = `https://api.henrikdev.xyz/valorant/v3/matches/${region}/${name}/${tag}?size=15&api_key=${process.env.VALORANT_API_KEY}`;
                const mmrUrl = `https://api.henrikdev.xyz/valorant/v1/mmr/${region}/${name}/${tag}?api_key=${process.env.VALORANT_API_KEY}`;

                const [matchesRes, mmrRes] = await Promise.all([
                    axios.get(matchesUrl).catch(e => ({ data: { data: [] } })),
                    axios.get(mmrUrl).catch(e => ({ data: { data: null } }))
                ]);

                const matches = matchesRes.data.data;
                const mmr = mmrRes.data.data;
                const stats = getTopStats(matches, null, name, tag);

                if (!stats) return null;

                return {
                    name: riotId,
                    displayName: displayName,
                    rank: (mmr && mmr.currenttierpatched) ? mmr.currenttierpatched : "Unranked",
                    kda: stats.kda,
                    mainAgent: stats.topAgent,
                    hs: stats.hs
                };

            } catch (e) {
                errors.push(`Error fetching ${riotId}`);
                return null;
            }
        };

        const promises = usersToAnalyze.map(u => fetchPlayerStats(u));
        const results = await Promise.all(promises);
        results.forEach(r => { if (r) playerData.push(r); });

        if (playerData.length === 0) {
            return loadingMsg.edit(`❌ Failed to analyze players.\nErrors:\n${errors.join('\n')}`);
        }

        const teamDescription = playerData.map(p => {
            return `Player: ${p.displayName} (Rank: ${p.rank}, Main: ${p.mainAgent}, KD: ${p.kda})`;
        }).join('\n');

        // Calculate missing slots to fill a 5-stack
        const missingSlots = 5 - playerData.length;
        const fillInstruction = missingSlots > 0
            ? `4. CRITICAL: We need a full 5-man team. Recommend ${missingSlots} additional agents to fill the empty slots. Format them as: ASSIGNMENT: Recommended (Bot) | [Agent] | [Role] | [Why needed]`
            : "";

        const prompt = `
        You are a tactical Valorant Coach using the Groove AI Model.
        **Objective**: Build the BEST team composition for the map: **${mapName}**.
        
        **Available Roster (${playerData.length} Players):**
        ${teamDescription}
        
        **Instructions:**
        1. Assign the BEST agent for each human player from the roster.
        2. ${missingSlots > 0 ? "Fill the remaining slots to make a perfect 5-man team." : "Ensure the team is balanced."}
        3. EXPLAIN strictly in this format for parsing (One line per assignment):
        ASSIGNMENT: [Player Name] | [Agent] | [Role (e.g. Smoker)] | [Why they fit this role & map in 1 short sentence]
        
        ${fillInstruction}

        5. After assignments, provide:
        STRATEGY: [One sentence winning condition for this team]
        
        Keep it concise.
        `;

        try {
            const aiResponse = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
                model: "llama-3.3-70b-versatile",
                messages: [
                    { role: "system", content: "You are a specialized Valorant Team Builder." },
                    { role: "user", content: prompt }
                ],
                max_tokens: 1000
            }, {
                headers: {
                    'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
                    'Content-Type': 'application/json'
                }
            });

            const rawText = aiResponse.data.choices[0].message.content;

            // Parse response for UI
            const embed = new EmbedBuilder()
                .setColor(0x2ECC71)
                .setTitle(`🛡️ Team Strategy: ${mapName.toUpperCase()}`)
                .setThumbnail('https://img.icons8.com/color/48/valorant.png')
                .setFooter({ text: 'Powered by Spicy • Coach Mode' });

            const assignments = [];
            let strategy = "Play together and trade kills.";

            const lines = rawText.split('\n');
            lines.forEach(line => {
                if (line.includes('ASSIGNMENT:')) {
                    const parts = line.replace('ASSIGNMENT:', '').split('|').map(s => s.trim());
                    if (parts.length >= 4) {
                        const isBot = parts[0].toLowerCase().includes('recommended') || parts[0].toLowerCase().includes('(bot)');
                        embed.addFields({
                            name: `${isBot ? '🤖' : '👤'} ${parts[0]} as ${parts[1]}`,
                            value: `**Role**: ${parts[2]}\n**Plan**: ${parts[3]}`,
                            inline: false
                        });
                    }
                } else if (line.includes('STRATEGY:')) {
                    strategy = line.replace('STRATEGY:', '').trim();
                }
            });

            embed.setDescription(`**🏆 Win Condition**\n${strategy}`);

            if (embed.data.fields && embed.data.fields.length === 0) {
                // Fallback if parsing failed
                embed.setDescription(rawText);
            }

            await loadingMsg.edit({ content: '', embeds: [embed] });

        } catch (error) {
            console.error(error);
            await loadingMsg.edit("❌ Error generating team strategy. AI Error.");
        }
    }
});

client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isButton()) return;

    // Timeline Buttons
    if (interaction.customId.startsWith('timeline_')) {
        await interaction.deferUpdate(); // Prevent "Unknown interaction" timeout

        const parts = interaction.customId.split('_');
        const action = parts[1];
        let currentPage = parseInt(parts[2]);
        const matchId = parts[3];

        let newPage = action === 'next' ? currentPage + 1 : currentPage - 1;

        try {
            // Re-fetch match data (Stateless)
            const matchUrl = `https://api.henrikdev.xyz/valorant/v2/match/${matchId}?api_key=${process.env.VALORANT_API_KEY}`;
            const matchRes = await axios.get(matchUrl);
            const matchData = matchRes.data.data;
            const timeline = analyzeMatch(matchData, null);

            const embed = createTimelineEmbed(matchData, timeline, newPage);
            const totalPages = Math.ceil(timeline.length / 3);

            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`timeline_prev_${newPage}_${matchId}`)
                        .setLabel('Previous')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(newPage <= 1),
                    new ButtonBuilder()
                        .setCustomId(`timeline_next_${newPage}_${matchId}`)
                        .setLabel('Next')
                        .setStyle(ButtonStyle.Primary)
                        .setDisabled(newPage >= totalPages)
                );

            await interaction.editReply({ embeds: [embed], components: [row] }); // Use editReply after deferUpdate

        } catch (e) {
            console.error(e);
            await interaction.followUp({ content: "❌ Error navigating timeline.", ephemeral: true });
        }
        return;
    }

    // Link Buttons
    if (interaction.customId.startsWith('link_yes_')) {
        const parts = interaction.customId.split('_');
        const userId = parts[2];
        const riotId = parts.slice(3).join('_');

        if (interaction.user.id !== userId) {
            return interaction.reply({ content: "This is not your confirmation button.", ephemeral: true });
        }

        let users = {};
        if (fs.existsSync(path)) {
            users = JSON.parse(fs.readFileSync(path));
        }

        users[userId] = {
            discordId: userId,
            riotId: riotId,
            username: interaction.user.username
        };

        fs.writeFileSync(path, JSON.stringify(users, null, 2));

        await interaction.update({ content: `✅ Successfully linked **${riotId}** to your account!`, embeds: [], components: [] });
        await interaction.followUp(`Please set your nickname using: \`/valo -nickname ${riotId} [nickname]\` (Example: \`/valo -nickname ${riotId} spicydn\`)`);

    } else if (interaction.customId.startsWith('link_no_')) {
        const parts = interaction.customId.split('_');
        const userId = parts[2];
        if (interaction.user.id !== userId) return;

        await interaction.update({ content: '❌ Linking cancelled.', embeds: [], components: [] });
    }
});

client.login(process.env.DISCORD_TOKEN);

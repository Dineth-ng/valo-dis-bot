const { EmbedBuilder } = require('discord.js');

/**
 * Parsing logic for Advanced Match Analytics
 */

// Helper to find the agent name/icon for a player PUUID
function getPlayerIdentity(matchData, puuid) {
    const player = matchData.players.all_players.find(p => p.puuid === puuid);
    return player ? {
        name: player.name,
        tag: player.tag,
        agent: player.character,
        team: player.team.toLowerCase(),
        rank: player.currenttier_patched
    } : { name: 'Unknown', tag: '', agent: '?', team: 'neutral', rank: '' };
}

function analyzeMatch(matchData, targetRiotId) {
    const timeline = [];
    const rounds = matchData.rounds;

    if (!rounds || rounds.length === 0) return [];

    let currentScore = { red: 0, blue: 0 };

    rounds.forEach((round, index) => {
        const roundNum = index + 1;
        const winnerTeam = round.winning_team.toLowerCase();

        // Update score
        if (winnerTeam === 'red') currentScore.red++;
        if (winnerTeam === 'blue') currentScore.blue++;

        const events = {
            roundNum: roundNum,
            winner: winnerTeam,
            endType: round.end_type,
            score: `${currentScore.blue} - ${currentScore.red}`,
            firstBlood: null,
            plant: null,
            defuse: null,
            kills: []
        };

        // --- Event Parsing ---

        // 1. Kills & First Blood
        // Filter kills for this round
        // HenrikDev V3: matchData.kills is a global array. We filter by `round` property which is 0-indexed? 
        // Let's verify round index in kills matches our loop index. Usually yes.
        const roundKills = matchData.kills.filter(k => k.round === index);

        // Sort by game_time (milliseconds) to ensure order
        roundKills.sort((a, b) => a.game_time - b.game_time);

        if (roundKills.length > 0) {
            const fbKill = roundKills[0];
            const fbKiller = getPlayerIdentity(matchData, fbKill.killer_puuid);
            const fbVictim = getPlayerIdentity(matchData, fbKill.victim_puuid);

            events.firstBlood = {
                killer: fbKiller.name,
                victim: fbVictim.name,
                team: fbKiller.team
            };

            // Format Kill Feed
            events.kills = roundKills.map(k => {
                const killer = getPlayerIdentity(matchData, k.killer_puuid);
                const victim = getPlayerIdentity(matchData, k.victim_puuid);
                const weapon = k.damage_weapon_name || 'Ability';

                // Highlight if it involves the target player (if provided)
                // We'll handle highlighting in Embed creation to keep data clean
                return {
                    killer: killer.name,
                    killerTeam: killer.team,
                    victim: victim.name,
                    victimTeam: victim.team,
                    weapon: weapon,
                    time: k.game_time
                };
            });
        }

        // 2. Plant
        if (round.plant_events && round.plant_events.plant_location) {
            const planter = getPlayerIdentity(matchData, round.plant_events.planted_by.puuid);
            events.plant = {
                site: round.plant_events.plant_site,
                player: planter.name,
                team: planter.team
            };
        }

        // 3. Defuse
        if (round.defuse_events && round.defuse_events.defuse_location) {
            const defuser = getPlayerIdentity(matchData, round.defuse_events.defused_by.puuid);
            events.defuse = {
                player: defuser.name,
                team: defuser.team
            };
        }

        timeline.push(events);
    });

    return timeline;
}

// Function to generate embeds for a specific page
function createTimelineEmbed(matchData, timeline, page = 1) {
    const ITEMS_PER_PAGE = 3; // Reduced to 3 for more detail
    const totalPages = Math.ceil(timeline.length / ITEMS_PER_PAGE);
    const startIndex = (page - 1) * ITEMS_PER_PAGE;
    const slicedRounds = timeline.slice(startIndex, startIndex + ITEMS_PER_PAGE);

    const meta = matchData.metadata;

    const embed = new EmbedBuilder()
        .setColor(0x2F3136) // Dark theme
        .setTitle(`📊 Match Timeline: ${meta.map} (${meta.mode})`)
        .setDescription(`**Final Score**: 🔵 ${matchData.teams.blue.rounds_won} - 🔴 ${matchData.teams.red.rounds_won}\n**Page**: ${page}/${totalPages}`)
        .setThumbnail(matchData.players.all_players[0].assets.card.small) // Just a nice image
        .setTimestamp(new Date(meta.game_start_patched));

    slicedRounds.forEach(round => {
        const winnerEmoji = round.winner === 'blue' ? '🔵' : '🔴';
        const winTypeObj = {
            'Eliminated': '💀 Elimination',
            'Bomb detonated': '💥 Detonation',
            'Bomb defused': '🧤 Defuse',
            'Time expired': '⏱️ Time'
        };
        const winType = winTypeObj[round.endType] || round.endType;

        let desc = `> **Winner**: ${winnerEmoji} ${round.winner.toUpperCase()} (${winType})\n`;
        desc += `> **Score**: 🔵 ${round.score.split(' - ')[0]} - 🔴 ${round.score.split(' - ')[1]}\n`;

        if (round.firstBlood) {
            desc += `🩸 **First Blood**: **${round.firstBlood.killer}** ➝ ${round.firstBlood.victim}\n`;
        }

        if (round.plant) {
            desc += `💣 **Plant**: **${round.plant.player}** @ ${round.plant.site}\n`;
        }
        if (round.defuse) {
            desc += `🧤 **Defuse**: **${round.defuse.player}**\n`;
        }

        // Kill Feed Summary (First 3 kills + '...') to avoid bloat, or maybe just meaningful ones?
        // User asked for "riotid killed by -> riotid summary"
        // Let's list all kills but compactly.
        if (round.kills.length > 0) {
            desc += `\n**⚔️ Kill Feed:**\n`;
            round.kills.forEach(k => {
                const weaponIcon = getWeaponEmoji(k.weapon);
                desc += `\`${k.killer}\` ${weaponIcon} \`${k.victim}\`\n`;
            });
        }

        embed.addFields({
            name: `Round ${round.roundNum}`,
            value: desc,
            inline: false
        });
    });

    return embed;
}

function getWeaponEmoji(weaponName) {
    // Simple mapper for some weapons, generic for others
    const w = weaponName.toLowerCase();
    if (w.includes('vandal')) return '🔫';
    if (w.includes('phantom')) return '👻';
    if (w.includes('operator')) return '🔭';
    if (w.includes('sheriff')) return '🤠';
    if (w.includes('spectre')) return '💨';
    if (w.includes('classic')) return '🔫';
    if (w.includes('ability')) return '✨';
    return '🔫';
}

module.exports = { analyzeMatch, createTimelineEmbed };

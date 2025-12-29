/**
 * Analytics logic for User Profile
 * Analyzes match history to find top stats.
 */

function getTopStats(matches, targetPuuid, targetName, targetTag) {
    const stats = {
        agents: {},
        maps: {},
        weapons: {},
        friends: {}
    };

    const totals = {
        kills: 0,
        deaths: 0,
        assists: 0,
        shots: 0,
        headshots: 0
    };

    if (!matches || matches.length === 0) return null;

    matches.forEach(match => {
        // Validation: Ensure match has metadata and players
        if (!match.metadata || !match.players || !match.players.all_players) return;

        // 1. Top Map
        const map = match.metadata.map;
        if (map) stats.maps[map] = (stats.maps[map] || 0) + 1;

        // Find player in match
        const player = match.players.all_players.find(p => p.puuid === targetPuuid || (p.name.toLowerCase() === targetName.toLowerCase() && p.tag.toLowerCase() === targetTag.toLowerCase()));

        if (player) {
            // Stats Accumulation
            totals.kills += player.stats.kills;
            totals.deaths += player.stats.deaths;
            totals.assists += player.stats.assists;
            totals.shots += (player.stats.bodyshots + player.stats.headshots + player.stats.legshots);
            totals.headshots += player.stats.headshots;

            // 2. Top Agent
            const agent = player.character;
            if (agent) stats.agents[agent] = (stats.agents[agent] || 0) + 1;

            // 3. Top Weapon (Scan kills)
            if (match.kills && Array.isArray(match.kills)) {
                const kills = match.kills.filter(k => k.killer_puuid === player.puuid);
                kills.forEach(k => {
                    let weapon = k.damage_weapon_name || 'Ability';
                    if (weapon === 'Ultimate') weapon = 'Ability';
                    stats.weapons[weapon] = (stats.weapons[weapon] || 0) + 1;
                });
            }

            // 4. Top Friend
            const myPartyId = player.party_id;
            if (myPartyId) {
                const teammates = match.players.all_players.filter(p =>
                    p.team === player.team &&
                    p.puuid !== player.puuid &&
                    p.party_id === myPartyId
                );

                teammates.forEach(tm => {
                    const id = `${tm.name}#${tm.tag}`;
                    stats.friends[id] = (stats.friends[id] || 0) + 1;
                });
            }
        }
    });

    const kd = totals.deaths > 0 ? (totals.kills / totals.deaths).toFixed(2) : totals.kills.toFixed(2);
    const hs = totals.shots > 0 ? Math.round((totals.headshots / totals.shots) * 100) : 0;

    return {
        topAgent: getTopKey(stats.agents),
        topMap: getTopKey(stats.maps),
        topWeapon: getTopKey(stats.weapons),
        topFriend: getTopKey(stats.friends),
        kda: kd,
        hs: `${hs}%`,
        totalKills: totals.kills
    };
}

function getTopKey(obj) {
    let topKey = 'N/A';
    let maxVal = 0;
    for (const [key, val] of Object.entries(obj)) {
        if (val > maxVal) {
            maxVal = val;
            topKey = key;
        }
    }
    return topKey === 'N/A' ? 'None' : `${topKey} (${maxVal})`;
}

module.exports = { getTopStats };

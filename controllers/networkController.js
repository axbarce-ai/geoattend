const networkService = require('../services/networkService');
const { logAction } = require('../services/auditService');

// GET /api/network/check (employee) -- used by the mobile app's network gate
// (WifiCheckScreen) instead of reading the Wi-Fi SSID. `enforced` is false
// while no allowed IPs have been configured yet, so a fresh deployment
// doesn't lock every employee out before an admin has set this up.
async function checkEmployeeNetwork(req, res, next) {
  try {
    const ip = await networkService.resolveClientIp(req);
    const entries = await networkService.getAllowedEntries();
    const enforced = entries.length > 0;
    res.json({
      success: true,
      data: { ip, enforced, allowed: !enforced || networkService.isAllowed(ip, entries) }
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/network/settings (super admin) -- `your_ip` is the admin's own
// public IP as the server sees it, so an admin sitting on the office network
// can add it to the list with one click.
async function getSettings(req, res, next) {
  try {
    const entries = await networkService.getAllowedEntries();
    res.json({ success: true, data: { allowed_ips: entries, your_ip: await networkService.resolveClientIp(req) } });
  } catch (err) {
    next(err);
  }
}

// PUT /api/network/settings (super admin) body: { allowed_ips: "a, b\nc" | ["a", "b"] }
async function updateSettings(req, res, next) {
  try {
    const { allowed_ips } = req.body;
    const entries = [...new Set(networkService.splitEntries(Array.isArray(allowed_ips) ? allowed_ips.join('\n') : allowed_ips))];
    const errors = entries.map(networkService.validateEntry).filter(Boolean);
    if (errors.length) {
      return res.status(400).json({ success: false, message: errors.join(' ') });
    }
    await networkService.saveAllowedEntries(entries);
    await logAction({ adminId: req.admin.id, action: 'update', module: 'network_settings', details: { allowed_ips: entries }, ip: req.ip });
    res.json({ success: true, message: 'Allowed network IPs saved.', data: { allowed_ips: entries } });
  } catch (err) {
    next(err);
  }
}

module.exports = { checkEmployeeNetwork, getSettings, updateSettings };

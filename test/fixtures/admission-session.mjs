// Focused admission tests override the native operations whose lifetime matters.
export class AdmissionSession {
  async prompt() {}
  async sendUserMessage() {}
  async steer() {}
  async followUp() {}
  async sendCustomMessage() {}
  async executeBash() {}
  async compact() {}
  async setModel() {}
  async cycleModel() {}
  async navigateTree() {}
  async reload() {}
}

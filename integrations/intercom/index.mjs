// Optional Pi Intercom integration. Registration/lifecycle are shared; the two
// capabilities have independent semantics and run at their own boundaries.
export default {
  id: 'pi-intercom',
  start({ id, services, onStop }) {
    onStop(services.readInputs.register(id, ['intercom_message']));
    onStop(
      services.daemonEnvironment.register((env) => {
        // A shared daemon must not inherit this Pi session's Intercom identity.
        // The actual Pi child keeps its normal native plugin environment.
        for (const key of Object.keys(env)) if (key.startsWith('PI_INTERCOM_')) delete env[key];
      }),
    );
  },
};

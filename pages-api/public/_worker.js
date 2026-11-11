export default {
  fetch(request, env) {
    return env.CARROT_API.fetch(request, { redirect: "manual" });
  },
};

// Node-RED integration temporarily disabled — see nodered/DEV_NOTES.md
// (gitignored) for status. This page isn't linked from the sidebar while
// disabled (components/Sidebar.tsx), but left in place so a direct visit to
// /automation shows a clear message instead of a broken iframe pointed at a
// proxy that server.js currently refuses to serve (NODERED_ENABLED = false).
//
// To re-enable: flip NODERED_ENABLED in server.js, uncomment the nav item in
// Sidebar.tsx, uncomment the `nodered` service in docker-compose.yml, and
// swap this component body back to the iframe below.
export default function AutomationPage() {
  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-4 border-b border-border">
        <h1 className="text-2xl font-semibold">Automation</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Node-RED integration is temporarily disabled.
        </p>
      </div>
    </div>
  );

  // return (
  //   <div className="h-full flex flex-col">
  //     <div className="px-6 py-4 border-b border-border">
  //       <h1 className="text-2xl font-semibold">Automation</h1>
  //       <p className="text-sm text-muted-foreground mt-0.5">
  //         Node-RED — build custom flows from MQTT events (APD, fire/smoke, face) to alerts,
  //         webhooks, or anything else in its node ecosystem.
  //       </p>
  //     </div>
  //     <iframe
  //       src="/nodered/"
  //       title="Automation (Node-RED)"
  //       className="flex-1 w-full border-0"
  //     />
  //   </div>
  // );
}

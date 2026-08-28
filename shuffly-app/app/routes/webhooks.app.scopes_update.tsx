import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
    const { payload, session, topic, shop } = await authenticate.webhook(request);
    console.log(`Received ${topic} webhook for ${shop}`);

    try {
        const current = payload.current as string[];
        if (session) {
            await db.session.update({
                where: {
                    id: session.id
                },
                data: {
                    scope: current.toString(),
                },
            });
        }
    } catch (err) {
        console.error(`[webhook:app/scopes_update] failed for ${shop}:`, err);
        return new Response(null, { status: 500 });
    }
    return new Response();
};

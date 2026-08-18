import {
  reactExtension,
  BlockStack,
  Heading,
  Text,
  Button,
} from '@shopify/ui-extensions-react/checkout';

// 決済完了(Thank youページ)に、ガチャページへの導線ボタンを表示する。
// Shopifyの仕様上、決済完了ページからの完全自動リダイレクトは全マーチャント共通で
// 許可されていないため(悪用防止のためのプラットフォーム側の制約)、
// 「1タップでガチャページへ飛べる、必ず表示される大きなボタン」という形で実現する。
//
// GACHA_PAGE_URL は実際のストアのガチャページのフルURLに置き換えること。
const GACHA_PAGE_URL = 'https://mathliberty-demo.myshopify.com/pages/gacha';

export default reactExtension('purchase.thank-you.block.render', () => <GachaThankYouCta />);

function GachaThankYouCta() {
  return (
    <BlockStack border="base" cornerRadius="base" padding="base" spacing="base" inlineAlignment="center">
      <Heading level={2}>ご購入ありがとうございます!</Heading>
      <Text>下のボタンからガチャページへ進んで、さっそく引いてみましょう。</Text>
      <Button kind="primary" to={GACHA_PAGE_URL} external>
        ガチャを回しに行く →
      </Button>
    </BlockStack>
  );
}

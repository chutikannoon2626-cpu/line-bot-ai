// Greeting Card — แสดงครั้งแรกในช่วงเวลาทำการ 08:00–17:59
export function greetingCard() {
  return {
    type: 'flex' as const,
    altText: 'Spenderclub ยินดีให้บริการค่ะ',
    contents: {
      type: 'bubble' as const,
      body: {
        type: 'box' as const,
        layout: 'vertical' as const,
        paddingAll: 'lg',
        contents: [
          {
            type: 'text' as const,
            text: 'Spenderclub ยินดีให้บริการค่ะ',
            weight: 'bold' as const,
            size: 'md' as const,
            wrap: true,
          },
          {
            type: 'text' as const,
            text: 'มีอะไรให้น้องใจดีช่วยคะ หรือสามารถกดปุ่มเพื่อสอบถามได้เลยค่ะ',
            size: 'sm' as const,
            color: '#666666',
            wrap: true,
            margin: 'sm' as const,
          },
        ],
      },
      footer: {
        type: 'box' as const,
        layout: 'vertical' as const,
        spacing: 'sm' as const,
        paddingAll: 'md',
        contents: [
          {
            type: 'button' as const,
            style: 'primary' as const,
            color: '#1A3A5C',
            action: {
              type: 'message' as const,
              label: 'สอบถาม Spendernetwork',
              text: 'สอบถาม Spendernetwork',
            },
          },
          {
            type: 'button' as const,
            style: 'secondary' as const,
            action: {
              type: 'message' as const,
              label: 'วิทยุสื่อสาร/ราคา',
              text: 'สอบถามการใช้งานและราคา',
            },
          },
          {
            type: 'button' as const,
            style: 'secondary' as const,
            action: {
              type: 'message' as const,
              label: 'แจ้งปัญหาการใช้งาน',
              text: 'แจ้งปัญหาการใช้งาน',
            },
          },
        ],
      },
    },
  }
}

// Image Intent Card — แสดงเมื่อลูกค้าส่งรูป
export function imageIntentCard() {
  return {
    type: 'flex' as const,
    altText: 'ต้องการให้น้องใจดีช่วยเรื่องอะไรคะ',
    contents: {
      type: 'bubble' as const,
      body: {
        type: 'box' as const,
        layout: 'vertical' as const,
        paddingAll: 'lg',
        contents: [
          {
            type: 'text' as const,
            text: 'ต้องการให้น้องใจดีช่วยเรื่องอะไรคะ',
            weight: 'bold' as const,
            size: 'md' as const,
            wrap: true,
          },
          {
            type: 'text' as const,
            text: 'รบกวนเลือกหัวข้อด้านล่างให้เจ้าหน้าที่หรือระบบดูแลต่อได้เลยค่ะ',
            size: 'sm' as const,
            color: '#666666',
            wrap: true,
            margin: 'sm' as const,
          },
        ],
      },
      footer: {
        type: 'box' as const,
        layout: 'vertical' as const,
        spacing: 'sm' as const,
        paddingAll: 'md',
        contents: [
          {
            type: 'button' as const,
            style: 'primary' as const,
            color: '#1A3A5C',
            action: {
              type: 'message' as const,
              label: 'ราคา',
              text: 'สอบถามราคาสินค้า',
            },
          },
          {
            type: 'button' as const,
            style: 'secondary' as const,
            action: {
              type: 'message' as const,
              label: 'สเปค/ฟังก์ชัน',
              text: 'สอบถามสเปก',
            },
          },
          {
            type: 'button' as const,
            style: 'secondary' as const,
            action: {
              type: 'message' as const,
              label: 'วิธีสั่งซื้อ',
              text: 'สอบถามวิธีสั่งซื้อ',
            },
          },
          {
            type: 'button' as const,
            style: 'secondary' as const,
            action: {
              type: 'message' as const,
              label: 'เกี่ยวกับ Spendernetwork',
              text: 'สอบถาม Spendernetwork',
            },
          },
          {
            type: 'separator' as const,
            margin: 'sm' as const,
          },
          {
            type: 'button' as const,
            style: 'link' as const,
            action: {
              type: 'uri' as const,
              label: '🌐 ดูข้อมูลสินค้าที่ spenderclub.com',
              uri: 'https://www.spenderclub.com',
            },
          },
        ],
      },
    },
  }
}

// Catalog Card — แสดงรายการสินค้าวิทยุสื่อสาร
export function catalogCard(
  items: { name: string; model?: string; price: number; detail?: string }[]
) {
  return {
    type: 'flex' as const,
    altText: 'รายการสินค้า Spender Club',
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#1A3A5C',
        contents: [
          {
            type: 'text',
            text: 'รายการสินค้า',
            weight: 'bold',
            size: 'xl',
            color: '#FFFFFF',
          },
          {
            type: 'text',
            text: 'Spender Club · วิทยุสื่อสาร',
            size: 'sm',
            color: '#AACCEE',
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: items.map((item) => ({
          type: 'box',
          layout: 'vertical',
          spacing: 'xs',
          contents: [
            {
              type: 'box',
              layout: 'horizontal',
              contents: [
                {
                  type: 'text',
                  text: item.model ? `${item.name} (${item.model})` : item.name,
                  size: 'sm',
                  weight: 'bold',
                  flex: 3,
                  wrap: true,
                },
                {
                  type: 'text',
                  text: `${item.price.toLocaleString()} ฿`,
                  size: 'sm',
                  align: 'end',
                  color: '#1A3A5C',
                  weight: 'bold',
                  flex: 2,
                },
              ],
            },
            ...(item.detail
              ? [
                  {
                    type: 'text' as const,
                    text: item.detail,
                    size: 'xs',
                    color: '#888888',
                    wrap: true,
                  },
                ]
              : []),
            { type: 'separator' as const },
          ],
        })),
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#1A3A5C',
            action: {
              type: 'message',
              label: 'สนใจสั่งซื้อ',
              text: 'ขอแอดมินติดต่อกลับ',
            },
          },
        ],
      },
    },
  }
}

// Contact Card — ข้อมูลติดต่อ Spender Club
export function contactCard(contact: {
  phone?: string
  line?: string
  address?: string
  hours?: string
}) {
  const rows = []

  if (contact.phone) {
    rows.push({
      type: 'box' as const,
      layout: 'horizontal' as const,
      spacing: 'sm',
      contents: [
        { type: 'text' as const, text: '📞', size: 'sm', flex: 1 },
        { type: 'text' as const, text: contact.phone, size: 'sm', flex: 4, wrap: true },
      ],
    })
  }

  if (contact.line) {
    rows.push({
      type: 'box' as const,
      layout: 'horizontal' as const,
      spacing: 'sm',
      contents: [
        { type: 'text' as const, text: '💬', size: 'sm', flex: 1 },
        { type: 'text' as const, text: `LINE: ${contact.line}`, size: 'sm', flex: 4, wrap: true },
      ],
    })
  }

  if (contact.address) {
    rows.push({
      type: 'box' as const,
      layout: 'horizontal' as const,
      spacing: 'sm',
      contents: [
        { type: 'text' as const, text: '📍', size: 'sm', flex: 1 },
        { type: 'text' as const, text: contact.address, size: 'sm', flex: 4, wrap: true },
      ],
    })
  }

  if (contact.hours) {
    rows.push({
      type: 'box' as const,
      layout: 'horizontal' as const,
      spacing: 'sm',
      contents: [
        { type: 'text' as const, text: '🕐', size: 'sm', flex: 1 },
        { type: 'text' as const, text: contact.hours, size: 'sm', flex: 4, wrap: true },
      ],
    })
  }

  return {
    type: 'flex' as const,
    altText: 'ข้อมูลติดต่อ Spender Club',
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#1A3A5C',
        contents: [
          {
            type: 'text',
            text: 'ติดต่อเรา',
            weight: 'bold',
            size: 'xl',
            color: '#FFFFFF',
          },
          {
            type: 'text',
            text: 'Spender Club',
            size: 'sm',
            color: '#AACCEE',
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: rows,
      },
    },
  }
}

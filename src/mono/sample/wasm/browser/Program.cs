// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System;
using System.Runtime.CompilerServices;

namespace Sample
{
    public class Test
    {
        public static void Main(string[] args)
        {
            Console.WriteLine ("Hello, World!");
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        public static int TestMeaning()
        {
            TestExcFilter();

            return 42;
        }

        static int answer;

        static bool CheckAnswer()
        {
            System.Console.WriteLine($"check: {answer} == 42 => {answer == 42}");

            return answer == 42;
        }

        static void TestExcFilter()
        {
            answer = 42;
            try
            {
                Method();
            }
            catch (Exception) when (CheckAnswer())
            {
                System.Console.WriteLine($"catch in TestExcFilter, answer: {answer}");
            }
        }

        static void Method()
        {
            try
            {
                System.Console.WriteLine("going to throw");
                throw new Exception("Throw");
            }
            finally
            {
                System.Console.WriteLine("finally: answer = 1");
                answer = 1;
            }
        }
    }
}
